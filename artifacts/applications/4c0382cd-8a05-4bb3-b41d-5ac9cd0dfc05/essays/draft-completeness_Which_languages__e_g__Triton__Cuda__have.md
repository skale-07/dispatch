# DRAFT (UNVERIFIED) — edit before approving

Question: Which languages (e.g. Triton, Cuda) have you used for writing or optimizing GPU kernels? Please include how long you’ve 

---

I have not written GPU kernels in Triton or CUDA, so I would be starting there. The closest low-level work I have done is programming a microcontroller-based dust sensor in C/C++ for my Valley Fever research, where I built an SIR-style epidemiological model in Python from its differential equations and connected it to environmental dust and agriculture variables. On the GPU side, my experience is at the framework level: I trained a convolutional neural network in PyTorch for facial-landmark prediction and reached roughly 95% PCK after hyperparameter tuning and model selection, and I currently build the machine-learning core of an anomaly-detection system at Summer Atlantic Capital, including temporal sequence modeling over event streams with RNN and Transformer-style approaches. That work has made me care about where time and memory actually go in a model rather than treating the framework as a black box. I learn by building, and I would rather say plainly that kernel programming is new to me than overstate it. If it is useful, I am happy to work through a Triton exercise before or during the process so you can judge the ramp directly.
