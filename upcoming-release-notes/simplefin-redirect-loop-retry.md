---
category: Bugfix
authors: [abloomston]
---

SimpleFIN bank sync now retries a bridge that keeps redirecting and says the failure is probably temporary (naming the bridge that is looping), instead of failing with "Too many redirects".
