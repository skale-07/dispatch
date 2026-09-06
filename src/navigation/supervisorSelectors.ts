/** Navigation observation registry v1. Values are excluded from model observations. */
export const supervisorSelectorsV1 = {
  controls: 'a[href], button, input[type="button"], input[type="submit"], [role="button"], [role="tab"]',
  privateValues: 'input, textarea, [contenteditable="true"]',
  removedText: 'script, style, noscript, input, textarea, [contenteditable="true"]',
  apply: /^apply(?:\s+now|\s+manually|\s+for this (?:job|role|position)(?:\s+online)?|\s+without saving)?$/i,
  forbidden: /\b(submit|send|withdraw|delete|purchase|pay|accept offer|save application)\b/i,
  authSubmit: /^(sign\s*in|log\s*in|create\s+(?:an?\s+)?account|register|continue)$/i,
} as const;
