---
category: Bugfix
authors: [abloomston]
---

Handle non-JSON responses from the SimpleFIN bridge (Cloudflare error pages, empty bodies) as transient upstream errors and retry them with backoff instead of failing bank sync on a JSON parse error.
