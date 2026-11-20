# #496 current-policy guidance preparation

Owner approved the previously parked 45–90 minute preparation, without real model
calls. Reused native scenario parsing/assertions and pinned the source revision,
policy and scenario digest. Added eight static synthetic fixtures, matched prompt
construction and a bounded trace scorer with good/bad/recovery/refusal checks.
The report separates scripted scaffold correctness from any empirical LLM claim.
No GitHub/model transport or live workflow experiment was introduced; #78 stays
separately deferred. Work was isolated from the existing dirty user checkout.
