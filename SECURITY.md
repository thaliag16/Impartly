# Security

## Reporting a problem
Please open a private security advisory on this repository rather than a public issue.

## Rules for contributors
- No keys, tokens or personal email content in commits, issues or test fixtures.
- Test fixtures use invented newsletters, never real inbox data.
- Model files are downloaded from the publisher's own account at a pinned
  revision and verified by hash. Only ONNX or safetensors files are loaded.
- The speech functions receive text and return audio. They hold no Gmail
  tokens and no database admin key.
