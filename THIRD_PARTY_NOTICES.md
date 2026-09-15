# Third-party notices

Giclaw is MIT licensed. This file records third-party projects whose code or
design Giclaw has drawn on, together with their license terms.

---

## OpenClaw

- Project: OpenClaw (`github.com/openclaw/openclaw`), version `2026.9.4`
- License: MIT
- Copyright (c) 2026 OpenClaw Foundation

Giclaw's extension system is modelled on OpenClaw's plugin architecture. The
following parts are adaptations of OpenClaw code or design, reimplemented for
Giclaw's narrower scope:

| Giclaw | OpenClaw source | How it was used |
| --- | --- | --- |
| `src/plugins/*` | `src/plugins/*` | Plugin kernel in OpenClaw's shape: manifest → discovery → enablement/validation → runtime registration → capability registry. |
| `src/plugin-sdk/*` | `src/plugin-sdk/*` | The facade plugin authors import; naming (`definePluginEntry`, `registerChannel`, `registerService`, `registerHttpRoute`) follows OpenClaw. |
| `src/extensions/webhook` | `extensions/webhooks` | Outbound HMAC-signed webhook and the "fixed verbs" inbound policy. |
| `src/extensions/imap` | `extensions/imap` | Mailbox watcher semantics: read-only mailbox selection, cursor initialised to `UIDNEXT - 1`, UIDVALIDITY reset, sender gate, at-least-once dispatch with bounded retries, persisted per-account state. Giclaw uses the same IMAP/DKIM stack as OpenClaw (`imapflow` 1.7.8, `mailparser` 3.9.20, `mailauth` 5.0.3) and drops OpenClaw's prompt rendering. |
| `src/extensions/feishu` | `extensions/feishu` | Transport concepts only (tenant token, custom-bot signing, interactive cards, event callback). Giclaw uses the official `@larksuiteoapi/node-sdk` 1.74.0 for the long-connection transport and its own AES-CBC / SHA-256 event verification. |
| `src/utils/mail.ts` | `extensions/imap/src/*` | Address-atom parsing rules, ported and shared between the SMTP and IMAP connectors. |

OpenClaw's license text:

```text
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Runtime dependencies shared with OpenClaw

These npm packages are used directly and are all MIT licensed:

| Package | Version | Used by |
| --- | --- | --- |
| `@larksuiteoapi/node-sdk` | 1.74.0 | `src/extensions/feishu` (long-connection transport) |
| `imapflow` | 1.7.8 | `src/extensions/imap` (IMAP client) |
| `mailparser` | 3.9.20 | `src/extensions/imap` (message parsing) |
| `mailauth` | 5.0.3 | `src/extensions/imap` (DKIM/SPF/DMARC verification) |

### Deliberate differences

Giclaw does not reproduce OpenClaw's conversational layer. An inbound message
never becomes a prompt; it only selects a configured routine or task list.
Giclaw also adds an SMTP outbound connector, which OpenClaw does not have.
