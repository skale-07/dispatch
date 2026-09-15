# DRAFT (UNVERIFIED) — edit before approving

Question: Tell us about the most challenging or impressive GPU kernel you've built or studied closely. What made it difficult or n

---

I have not written a GPU kernel, so I would rather say that plainly than dress up something I did not do. The closest I have worked to hardware was my Valley Fever research, where I programmed a microcontroller-based dust sensor in C/C++ alongside an SIR-style epidemiological model I built in Python from its differential equations. That project was small, but it was the first time I had to reason about a system where the constraint was the device in front of me rather than the abstraction.

My deep learning work so far has lived at the framework level. I trained a convolutional network in PyTorch for facial-landmark prediction and got to roughly 95% PCK after hyperparameter tuning and model selection, and at Summer Atlantic Capital I built the machine-learning core of an anomaly-detection system, including temporal sequence modeling over event streams with RNN and Transformer-style approaches, anomaly scoring, and a learning-to-rank layer for prioritizing alerts. I own the event-ingestion pipeline and a versioned FastAPI detection service, so I have spent real time on where things actually get slow and where they fail.

The part I would want to work on is exactly the layer I have been treating as a black box. I learn by building, and I would rather be honest about starting below the line than overstate it.
