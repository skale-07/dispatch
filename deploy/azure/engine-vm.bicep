// Dispatch hosted engine on Azure, v0 — the AWS stack (deploy/aws/engine-ec2.yaml)
// re-expressed for Azure credits (operator decision 2026-09-16): ONE Ubuntu VM
// running the tenant scheduler container (deploy/engine.Dockerfile), tenant
// workspaces on a managed data disk that outlives the VM, the engine's .env
// as a Key Vault secret read by the VM's managed identity, the image pulled
// from Azure Container Registry by the same identity. No inbound ports at all:
// the NSG denies every inbound flow; operator access is `az vm run-command`.
//
// The ACR and the Key Vault are created by deploy/azure/deploy.sh bootstrap
// (they must exist before the image push and the secret upload) and are
// referenced here as existing resources so the two role assignments the VM
// needs (AcrPull, Key Vault Secrets User) live with the VM.
targetScope = 'resourceGroup'

@description('Prefix for every resource this template creates.')
param name string = 'dispatch'

@description('Region; defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('Full image reference in the ACR, e.g. dispatchacr.azurecr.io/dispatch-engine:abc123def456')
param image string

@description('Existing Azure Container Registry name (deploy.sh bootstrap).')
param acrName string

@description('Existing Key Vault name holding the engine env secret (deploy.sh bootstrap).')
param keyVaultName string

@description('Name of the Key Vault secret whose value is the engine .env content.')
param envSecretName string = 'engine-env'

@description('2 vCPU / 8 GiB fits one headless Chromium per concurrent tenant run plus the scheduler.')
param vmSize string = 'Standard_D2s_v5'

@description('Data disk (GiB) mounted at /data/dispatch: tenants, SQLite, artifacts. Detached, never deleted, with the VM.')
param dataDiskGb int = 64

param adminUsername string = 'dispatch'

@description('SSH public key the VM is provisioned with (Azure requires one). Inbound SSH is blocked by the NSG; operator access is az vm run-command.')
param sshPublicKey string

// Built-in role definition ids (stable across tenants).
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// cloud-init: docker + azure-cli, the data disk formatted once and mounted,
// a refresh script (secret -> env file 0600, ACR login, pull the image named
// in /etc/dispatch/image) and a systemd unit that runs the container forever.
// Tokens are replaced below (Bicep multi-line strings do not interpolate).
var cloudInitTemplate = '''
#cloud-config
package_update: true
packages:
  - docker.io
  - ca-certificates
  - curl
  - python3
disk_setup:
  /dev/disk/azure/scsi1/lun0:
    table_type: gpt
    layout: true
    overwrite: false
fs_setup:
  - device: /dev/disk/azure/scsi1/lun0
    partition: 1
    filesystem: ext4
    overwrite: false
mounts:
  - ["/dev/disk/azure/scsi1/lun0-part1", "/data/dispatch", "ext4", "defaults,nofail", "0", "2"]
write_files:
  - path: /etc/dispatch/image
    permissions: '0644'
    content: "__IMAGE__"
  - path: /etc/dispatch/vault
    permissions: '0644'
    content: "__VAULT__"
  - path: /etc/dispatch/secret-name
    permissions: '0644'
    content: "__SECRET__"
  - path: /etc/dispatch/acr
    permissions: '0644'
    content: "__ACR__"
  - path: /usr/local/bin/dispatch-engine-refresh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Secret -> env file (0600), ACR login, pull the image named in /etc/dispatch/image.
      set -euo pipefail
      IMAGE=$(cat /etc/dispatch/image)
      VAULT=$(cat /etc/dispatch/vault)
      SECRET=$(cat /etc/dispatch/secret-name)
      ACR=$(cat /etc/dispatch/acr)
      az login --identity --allow-no-subscriptions -o none
      umask 077
      az keyvault secret show --vault-name "$VAULT" --name "$SECRET" --query value -o json \
        | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin))' > /etc/dispatch/engine.env.tmp
      mv /etc/dispatch/engine.env.tmp /etc/dispatch/engine.env
      az acr login --name "$ACR" -o none
      docker pull "$IMAGE"
  - path: /etc/systemd/system/dispatch-engine.service
    permissions: '0644'
    content: |
      [Unit]
      Description=Dispatch hosted engine (tenant scheduler container)
      After=docker.service network-online.target data-dispatch.mount
      Requires=docker.service

      [Service]
      Type=simple
      ExecStartPre=/usr/local/bin/dispatch-engine-refresh
      ExecStartPre=-/usr/bin/docker rm -f dispatch-engine
      ExecStart=/bin/bash -c '/usr/bin/docker run --rm --name dispatch-engine --init --shm-size=1g \
        --env-file /etc/dispatch/engine.env \
        -v /data/dispatch:/data \
        --log-driver json-file --log-opt max-size=50m --log-opt max-file=5 \
        "$(cat /etc/dispatch/image)"'
      ExecStop=/usr/bin/docker stop -t 90 dispatch-engine
      Restart=always
      RestartSec=15

      [Install]
      WantedBy=multi-user.target
runcmd:
  - chmod 700 /etc/dispatch
  - mkdir -p /data/dispatch
  - systemctl enable --now docker
  - curl -sL https://aka.ms/InstallAzureCLIDeb | bash
  - systemctl daemon-reload
  - systemctl enable --now dispatch-engine
'''

var cloudInit = replace(replace(replace(replace(cloudInitTemplate, '__IMAGE__', image), '__VAULT__', keyVaultName), '__SECRET__', envSecretName), '__ACR__', acrName)

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: '${name}-engine-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      {
        name: 'engine'
        properties: {
          addressPrefix: '10.42.1.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

// Egress only. The one inbound rule DENIES everything (the platform defaults
// already refuse the internet; this makes the intent explicit and reviewable).
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: '${name}-engine-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'DenyAllInbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowAllOutbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// A public IP gives the VM outbound internet (Supabase, the browser provider,
// ATS sites, LLM APIs) now that Azure's implicit default outbound access is
// retired for new networks. Nothing can come in through it: see the NSG.
resource publicIp 'Microsoft.Network/publicIPAddresses@2024-01-01' = {
  name: '${name}-engine-egress-ip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: '${name}-engine-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          subnet: { id: vnet.properties.subnets[0].id }
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: { id: publicIp.id }
        }
      }
    ]
    networkSecurityGroup: { id: nsg.id }
  }
}

// Tenant workspaces, SQLite and artifacts. Platform-key encryption at rest,
// detached (not deleted) if the VM goes away — the AWS DeleteOnTermination:false.
resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: '${name}-engine-data'
  location: location
  sku: { name: 'Premium_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: dataDiskGb
    encryption: { type: 'EncryptionAtRestWithPlatformKey' }
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: '${name}-engine'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: '${name}-engine'
      adminUsername: adminUsername
      customData: base64(cloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 32
        managedDisk: { storageAccountType: 'Premium_LRS' }
        deleteOption: 'Delete'
      }
      dataDisks: [
        {
          lun: 0
          createOption: 'Attach'
          managedDisk: { id: dataDisk.id }
          deleteOption: 'Detach'
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id }]
    }
  }
}

// The VM's identity may pull the image and read exactly this vault's secrets.
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, vm.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, vm.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output vmName string = vm.name
output vmPrincipalId string = vm.identity.principalId
output logs string = 'az vm run-command invoke -g ${resourceGroup().name} -n ${vm.name} --command-id RunShellScript --scripts "docker logs --tail 200 dispatch-engine"'
