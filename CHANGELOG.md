# Changelog

## [0.10.2](https://github.com/metaneutrons/eule-mcp/compare/v0.10.1...v0.10.2) (2026-10-18)


### Bug Fixes

* **deps:** patch rustls security advisories ([#116](https://github.com/metaneutrons/eule-mcp/issues/116)) ([5828edd](https://github.com/metaneutrons/eule-mcp/commit/5828eddd0216828b770e057bcee8b8f8f8462472))
* **imap:** upgrade ImapFlow to 2.4.0 ([#94](https://github.com/metaneutrons/eule-mcp/issues/94)) ([873305f](https://github.com/metaneutrons/eule-mcp/commit/873305fca49b3c5b35129b93deaec674c9f659b2))
* **m365:** send mail from graph accounts over SMTP like Thunderbird ([#118](https://github.com/metaneutrons/eule-mcp/issues/118)) ([70d0e8d](https://github.com/metaneutrons/eule-mcp/commit/70d0e8ddbc15bf442d55905fd250651df8b9f9d6))

## [0.10.1](https://github.com/metaneutrons/eule-mcp/compare/v0.10.0...v0.10.1) (2026-10-13)


### Bug Fixes

* **update:** save the bundle to the platform's real download folder ([#110](https://github.com/metaneutrons/eule-mcp/issues/110)) ([dcce273](https://github.com/metaneutrons/eule-mcp/commit/dcce273be029124819725902557282a0265a5de3))

## [0.10.0](https://github.com/metaneutrons/eule-mcp/compare/v0.9.1...v0.10.0) (2026-10-13)


### Features

* **update:** point out newer releases and fetch the verified bundle ([#107](https://github.com/metaneutrons/eule-mcp/issues/107)) ([8e01eb9](https://github.com/metaneutrons/eule-mcp/commit/8e01eb9b2ea7ef14cef6aefef5dd261ce6675fd3))


### Bug Fixes

* **imap:** read the decoded text part instead of the raw MIME source ([#106](https://github.com/metaneutrons/eule-mcp/issues/106)) ([3c1fd2e](https://github.com/metaneutrons/eule-mcp/commit/3c1fd2ea41e8f97c73e6210b1e856e23b118eef1))

## [0.9.1](https://github.com/metaneutrons/eule-mcp/compare/v0.9.0...v0.9.1) (2026-10-13)


### Bug Fixes

* **imap:** file sent mail in the folder the server flags as Sent (option sentMailbox) ([404ce76](https://github.com/metaneutrons/eule-mcp/commit/404ce7691a42b2959f002d35f4f66a498e84854b))
* **imap:** list an empty mailbox instead of failing ([404ce76](https://github.com/metaneutrons/eule-mcp/commit/404ce7691a42b2959f002d35f4f66a498e84854b))
* **imap:** take an existing folder name literally ([404ce76](https://github.com/metaneutrons/eule-mcp/commit/404ce7691a42b2959f002d35f4f66a498e84854b))

## [0.9.0](https://github.com/metaneutrons/eule-mcp/compare/v0.8.1...v0.9.0) (2026-10-12)


### Features

* ship Eule as a Claude Desktop extension (eule-mcp.mcpb) ([#100](https://github.com/metaneutrons/eule-mcp/issues/100)) ([4fea6a9](https://github.com/metaneutrons/eule-mcp/commit/4fea6a9e0adc68a4c3475ee2a7ed0471ff6430d5))

## [0.8.1](https://github.com/metaneutrons/eule-mcp/compare/v0.8.0...v0.8.1) (2026-10-11)


### Bug Fixes

* **imap:** file sent mail in the Sent folder ([8766c24](https://github.com/metaneutrons/eule-mcp/commit/8766c2416777b6c465c8da76220d501a583629d7))
* **mail:** resolve folder names for Exchange searches ([8766c24](https://github.com/metaneutrons/eule-mcp/commit/8766c2416777b6c465c8da76220d501a583629d7))

## [0.8.0](https://github.com/metaneutrons/eule-mcp/compare/v0.7.1...v0.8.0) (2026-10-11)


### ⚠ BREAKING CHANGES

* **tools:** require an explicit account for write operations ([#95](https://github.com/metaneutrons/eule-mcp/issues/95))

### Bug Fixes

* **tools:** require an explicit account for write operations ([#95](https://github.com/metaneutrons/eule-mcp/issues/95)) ([38ef373](https://github.com/metaneutrons/eule-mcp/commit/38ef3737e2e47ebf0044126f68531d8f052eecc0))

## [0.7.1](https://github.com/metaneutrons/eule-mcp/compare/v0.7.0...v0.7.1) (2026-10-06)


### Bug Fixes

* **deps:** update nodemailer to 10 and patch vulnerable transitive packages ([#89](https://github.com/metaneutrons/eule-mcp/issues/89)) ([c62bbeb](https://github.com/metaneutrons/eule-mcp/commit/c62bbeb327b1c2b451b7e3129e317d01d435ff56))

## [0.7.0](https://github.com/metaneutrons/eule-mcp/compare/v0.6.1...v0.7.0) (2026-10-06)


### Features

* **auth:** sign in to M365 through Safari and renew dead sign-ins that way ([#85](https://github.com/metaneutrons/eule-mcp/issues/85)) ([f855a65](https://github.com/metaneutrons/eule-mcp/commit/f855a656eacaaf80354306c04b262ec3feb2ae34))
* **auth:** take M365 TOTP codes from a YubiKey ([#84](https://github.com/metaneutrons/eule-mcp/issues/84)) ([fac1b50](https://github.com/metaneutrons/eule-mcp/commit/fac1b50003b94f27a9cac67220ac439cf85d6aa8))


### Bug Fixes

* **imap:** thread replies on the parent's Message-ID and send References ([#82](https://github.com/metaneutrons/eule-mcp/issues/82)) ([498666b](https://github.com/metaneutrons/eule-mcp/commit/498666bceae5552502a4b0542c52215944707ba6))
* **mail:** search every folder by default and bind IMAP ids to their mailbox ([#80](https://github.com/metaneutrons/eule-mcp/issues/80)) ([677529f](https://github.com/metaneutrons/eule-mcp/commit/677529f938e1aec1af76a0dfc14dc3f2347ccb5e))

## [0.6.1](https://github.com/metaneutrons/eule-mcp/compare/v0.6.0...v0.6.1) (2026-09-28)


### Bug Fixes

* **deps:** patch rustls, vite and esbuild advisories ([#70](https://github.com/metaneutrons/eule-mcp/issues/70)) ([52e4c9b](https://github.com/metaneutrons/eule-mcp/commit/52e4c9b252be4601ec41c7a2ccb431c8c7bcbd35))
* **m365:** keep stored auth tier, normalise EWS folders, read batched summaries ([#69](https://github.com/metaneutrons/eule-mcp/issues/69)) ([b5ecad6](https://github.com/metaneutrons/eule-mcp/commit/b5ecad64c2d9cb534bbb63bde3a2c24071400407))

## [0.6.0](https://github.com/metaneutrons/eule-mcp/compare/v0.5.0...v0.6.0) (2026-08-26)


### Features

* **auth:** harden native M365 credential autofill ([#50](https://github.com/metaneutrons/eule-mcp/issues/50)) ([4bfc305](https://github.com/metaneutrons/eule-mcp/commit/4bfc3054f1fd4c27d668efc962109f6e23097fe3))

## [0.5.0](https://github.com/metaneutrons/eule-mcp/compare/v0.4.0...v0.5.0) (2026-08-23)


### Features

* **mail:** add preview-first mail_bulk_update ([49645ef](https://github.com/metaneutrons/eule-mcp/commit/49645ef7d1e9ef192edb56114bcbe434a5f40f48))

## [0.4.0](https://github.com/metaneutrons/eule-mcp/compare/v0.3.0...v0.4.0) (2026-08-23)


### ⚠ BREAKING CHANGES

* **tasks:** task tools now operate on the user's task system instead of a local database. Task ids are provider strings rather than integers, and the GTD fields (status, project_id, context, waiting_for, estimated_hours) are gone. task_lists and task_delete are new. Existing rows in eule.db are not migrated.

### Features

* **cli:** choose the best login flow by default, demote browser paste ([b23241c](https://github.com/metaneutrons/eule-mcp/commit/b23241c9e6a0bc9464ac87751a7cc2340ebf624f))
* **mail:** batch mail_update and always name what was touched ([00383b5](https://github.com/metaneutrons/eule-mcp/commit/00383b5184c13b2e0f9f5ba768f0c4672710ad37))
* **tasks:** back tasks with Microsoft To Do and CalDAV, drop the local store ([df260ba](https://github.com/metaneutrons/eule-mcp/commit/df260bae5021dfc812bbe54ba6679b605fca27c3))


### Bug Fixes

* **caldav:** read iCal properties component-scoped and unfold before parsing ([3c45bc4](https://github.com/metaneutrons/eule-mcp/commit/3c45bc4dbf406bfac8448a340b384cf77de0a7ed))

## [0.3.0](https://github.com/metaneutrons/eule-mcp/compare/v0.2.2...v0.3.0) (2026-08-09)


### Features

* **auth:** expose native M365 webview login ([#36](https://github.com/metaneutrons/eule-mcp/issues/36)) ([3568f6e](https://github.com/metaneutrons/eule-mcp/commit/3568f6ed5718840b931adb8a01d59b73e34b99af))


### Bug Fixes

* **config:** support js-yaml v5 ([#37](https://github.com/metaneutrons/eule-mcp/issues/37)) ([a40e242](https://github.com/metaneutrons/eule-mcp/commit/a40e2420007d3b39433aafd9dbcdd3d1f1ed25e1))

## [0.2.2](https://github.com/metaneutrons/eule-mcp/compare/v0.2.1...v0.2.2) (2026-08-02)


### Bug Fixes

* allow safe cross-platform temp downloads ([#33](https://github.com/metaneutrons/eule-mcp/issues/33)) ([2b4649e](https://github.com/metaneutrons/eule-mcp/commit/2b4649ea5b964139a7381ef8f285d066b03478b6))

## [0.2.1](https://github.com/metaneutrons/eule-mcp/compare/v0.2.0...v0.2.1) (2026-07-28)


### Bug Fixes

* harden macOS release signing ([#31](https://github.com/metaneutrons/eule-mcp/issues/31)) ([d0bfc09](https://github.com/metaneutrons/eule-mcp/commit/d0bfc095782db1ed1d25b25a49d174d774cf5bf0))
* pass release signing secrets explicitly ([#32](https://github.com/metaneutrons/eule-mcp/issues/32)) ([2111167](https://github.com/metaneutrons/eule-mcp/commit/2111167eacfb0f8a698f8a4cb1bf2af7a51dbd75))
* remove deprecated release upload action ([#29](https://github.com/metaneutrons/eule-mcp/issues/29)) ([355e939](https://github.com/metaneutrons/eule-mcp/commit/355e9394ca7842180dbca3454e71bef85901412c))

## [0.2.0](https://github.com/metaneutrons/eule-mcp/compare/v0.1.0...v0.2.0) (2026-07-28)


### Features

* add centralized logger, route all output to stderr in MCP serve mode ([5b1843e](https://github.com/metaneutrons/eule-mcp/commit/5b1843ebbd2ce714acb50baa686a92ed6539c953))
* add DocumentConnector + Paperless-NGX provider + 7 doc tools ([9c89a76](https://github.com/metaneutrons/eule-mcp/commit/9c89a7602143f83680f605df0d78cd7ba19223d8))
* add Google Workspace provider (Gmail, Calendar, Contacts, Drive) ([76d8dd9](https://github.com/metaneutrons/eule-mcp/commit/76d8dd9739792982a7b247076947faf92ccfc071))
* add GraphCalendarConnector, all 3 tiers complete ([df14b07](https://github.com/metaneutrons/eule-mcp/commit/df14b07a32a8d3f2ff07b9013ff6d1ba2073925d))
* add ideas, notes, contacts managers and MCP tools ([70e4c85](https://github.com/metaneutrons/eule-mcp/commit/70e4c853a22f70619422296d3ea74c2505ed6033))
* add mail_draft tool — create drafts via Graph, EWS, Gmail ([d01b57b](https://github.com/metaneutrons/eule-mcp/commit/d01b57b7dd2e821055bc61a8faeb9b48dd1afe62))
* add mail_send_draft tool — explicit draft sending ([6762894](https://github.com/metaneutrons/eule-mcp/commit/676289448996b6aa4328aa9c390d0423960d943d))
* add MCP credential control plane ([#25](https://github.com/metaneutrons/eule-mcp/issues/25)) ([f800ad0](https://github.com/metaneutrons/eule-mcp/commit/f800ad055cdc5cdf3d970fd229eab17ca47e7b9f))
* add messenger (Signal + Teams) and file (SharePoint/OneDrive) connectors with 6 new tools ([85aa1e1](https://github.com/metaneutrons/eule-mcp/commit/85aa1e16569e32cd223779aa8f3f76410feea9c9))
* add secure configuration wizard ([#24](https://github.com/metaneutrons/eule-mcp/issues/24)) ([0d94e2e](https://github.com/metaneutrons/eule-mcp/commit/0d94e2e168919450d592e3234f74511583467f35))
* **auth:** browser-based OAuth2 with PKCE using Thunderbird client_id ([2031931](https://github.com/metaneutrons/eule-mcp/commit/20319311661193fd2ef21f093a2a9a8131412ad6))
* **auth:** optional headless TOTP auto-authentication via Playwright ([3b2c6bc](https://github.com/metaneutrons/eule-mcp/commit/3b2c6bc704e8d7987b62ba1b85c721638ec24d6f))
* **auth:** working headless TOTP auto-auth with FIDO bypass ([ea0584c](https://github.com/metaneutrons/eule-mcp/commit/ea0584c3a068290e128d9e6efdfb66c7afac413b))
* **briefing:** add daily briefing service and MCP tool ([c770b3c](https://github.com/metaneutrons/eule-mcp/commit/c770b3c50366f0ecc07d635cb8b256b5ac144473))
* **calendar:** add create/update/delete tools, update README ([443080e](https://github.com/metaneutrons/eule-mcp/commit/443080ecd3f4bf304e03fca2293bca4aaaab66a3))
* **calendar:** add EWS calendar connector with MCP tools ([0a70ace](https://github.com/metaneutrons/eule-mcp/commit/0a70ace45be612442e1650fd7a48f390256682be))
* **calendar:** multi-calendar support — list calendars, calendarId on create ([a216353](https://github.com/metaneutrons/eule-mcp/commit/a21635396b1cc705ab832707d044ec9fd83530e8))
* **carddav:** implement createContact via vCard PUT ([e7cd0b9](https://github.com/metaneutrons/eule-mcp/commit/e7cd0b923587a56b1b378b6ea9c6a4a4d711c60e))
* **contacts:** add ContactConnector with Graph + EWS, contact_search tool ([52a1a07](https://github.com/metaneutrons/eule-mcp/commit/52a1a07da202e859f841840e2877180b0a67e837))
* **doc_read:** optional markdown output via pymupdf4llm ([4af1746](https://github.com/metaneutrons/eule-mcp/commit/4af1746d9a7e4ee75b2170ab6a4f0129d97c4f8c))
* **file_read:** smart cache with metadata invalidation, pandoc conversion, range-based reading ([3b702a3](https://github.com/metaneutrons/eule-mcp/commit/3b702a3147b7fd5269ee954d6b270ce2edc5c33d))
* **files:** add file_download tool for binary downloads from OneDrive/Google Drive ([c8b1909](https://github.com/metaneutrons/eule-mcp/commit/c8b19092eea61147fb95a10598512c72bae81e24))
* **files:** add file_upload tool + uploadFile for Graph and Google Drive ([497dbe4](https://github.com/metaneutrons/eule-mcp/commit/497dbe47d1a2e03ee268430ef6ab005ccb6cc081))
* **google:** upgrade to rw scopes, implement contacts createContact ([dbf6137](https://github.com/metaneutrons/eule-mcp/commit/dbf613794c8fe9740d4a913dc8d24fc265d288ef))
* harden enterprise architecture ([#23](https://github.com/metaneutrons/eule-mcp/issues/23)) ([b73fe6d](https://github.com/metaneutrons/eule-mcp/commit/b73fe6dd6e3502e83185a2227f0552a472b63b21))
* **ical:** add read-only iCal feed calendar connector ([934e4f5](https://github.com/metaneutrons/eule-mcp/commit/934e4f5746e0e341be972d7c28b7ccaa01f91090))
* **icloud:** add CalDAV calendar + CardDAV contacts providers ([d1f688e](https://github.com/metaneutrons/eule-mcp/commit/d1f688e9e559203a066bd73b67b89bea6d95a526))
* **imap:** add createDraft via APPEND with Draft flag ([13edf72](https://github.com/metaneutrons/eule-mcp/commit/13edf72341b83c11bde1b024828ef0922115c266))
* **imap:** add sendDraft — fetch from Drafts, send via SMTP, move to Sent ([8b8bf9a](https://github.com/metaneutrons/eule-mcp/commit/8b8bf9a2cedf51e8a6646065d70c2aa3ef0e1504))
* **imap:** implement attachment download ([ec2f688](https://github.com/metaneutrons/eule-mcp/commit/ec2f6882cb4542300eec31c6ce404192a36ef5e5))
* initial project scaffolding ([006635c](https://github.com/metaneutrons/eule-mcp/commit/006635c11e2c7d87bc917497fe76541c46474cc9))
* M365 auth for locked-down tenants + cross-platform Rust helper ([#18](https://github.com/metaneutrons/eule-mcp/issues/18)) ([e68fcf9](https://github.com/metaneutrons/eule-mcp/commit/e68fcf94f40b700ad24cc1dbab6596b77a371d7c))
* **mail:** add displayName to From header and CC/BCC support across all connectors ([fdcd226](https://github.com/metaneutrons/eule-mcp/commit/fdcd22648e6c1af552852f89a8731cdf5bcb1e52))
* **mail:** add HTML output with markdown conversion, signatures, quote blocks ([46a7e2c](https://github.com/metaneutrons/eule-mcp/commit/46a7e2c426574104010618308c244bf6eb6c856a))
* **mail:** add optional signature param to mail_send and mail_draft ([ff2a93f](https://github.com/metaneutrons/eule-mcp/commit/ff2a93f88eeb49748dd3506bf7de762c2287397a))
* **mail:** implement Graph, EWS, IMAP mail connectors with MCP tools ([759fb1a](https://github.com/metaneutrons/eule-mcp/commit/759fb1a1b23e267e33d3470f2fe73bd9480eb67b))
* **mail:** layered mail rendering with HTML→Markdown, thread splitting, attachments ([413ad07](https://github.com/metaneutrons/eule-mcp/commit/413ad076e0dd15ecd46a0977f656ec7fcc08f1a2))
* **mail:** send and read email attachments across all providers ([#17](https://github.com/metaneutrons/eule-mcp/issues/17)) ([15928ee](https://github.com/metaneutrons/eule-mcp/commit/15928ee11265a4b6d257744fc89ecdb134d37ed9))
* **mail:** shared mailbox support for EWS + Graph with tokenAccount ([28991f6](https://github.com/metaneutrons/eule-mcp/commit/28991f6f0306442147ce6995882c2647e2037bf5))
* remove notes, contact_add writes to remote connectors with local fallback ([10aaac8](https://github.com/metaneutrons/eule-mcp/commit/10aaac84f275129dbec0feb828ebc2fa43a50f5d))
* **roles:** add role CRUD tools and ConfigManager methods ([8b07309](https://github.com/metaneutrons/eule-mcp/commit/8b07309c18d020f0e042a9e9a9f6cf9fb37d9f0d))
* **security:** add shared escaping/TLS/timeout/sandbox utilities ([0ebe181](https://github.com/metaneutrons/eule-mcp/commit/0ebe1819043585a59c522eba36bc47a70cdafa64))
* **tasks:** add GTD task engine ([7c77261](https://github.com/metaneutrons/eule-mcp/commit/7c77261b231fafec123889f15807946181cc7a88))
* **tasks:** add optional estimated_hours for capacity planning ([ad597e3](https://github.com/metaneutrons/eule-mcp/commit/ad597e308c21564c4ee345d66dfa24942a2ce728))


### Bug Fixes

* **auth:** detect CA sign-in frequency and surface re-auth prompt ([7ae7950](https://github.com/metaneutrons/eule-mcp/commit/7ae7950105500e5b181a3a7309e30561d3099ca8))
* **auth:** use nativeclient redirect URI matching Thunderbird's app registration ([a59ed68](https://github.com/metaneutrons/eule-mcp/commit/a59ed685fb1ef90f12df04ec5161ce8e9049bf32))
* **auth:** use stderr instead of stdout to avoid breaking MCP transport ([6c0e894](https://github.com/metaneutrons/eule-mcp/commit/6c0e894a8600ee6c0c0642827366bbce824d3c9d))
* **caldav:** update events in place instead of delete+recreate ([f7a9daa](https://github.com/metaneutrons/eule-mcp/commit/f7a9daaa96725866967b4c034033fa0e85eca989))
* **ews:** disable entity processing to handle HTML-heavy email bodies ([c599a56](https://github.com/metaneutrons/eule-mcp/commit/c599a56e1d510f104df1f169692b039ebba538ac))
* **ews:** fix body extraction regex and snippet parsing ([2bf0c08](https://github.com/metaneutrons/eule-mcp/commit/2bf0c082b7ac99c0e108d84f7ffe2a0cf9026939))
* **ews:** fix From/Mailbox array handling, remove unsupported Preview from FindItem ([347e417](https://github.com/metaneutrons/eule-mcp/commit/347e4171c8bfa3afc073638b0e9f3ecf97f8d3ac))
* **ews:** raise entity expansion limit for HTML-heavy emails ([28eb02e](https://github.com/metaneutrons/eule-mcp/commit/28eb02e0204611a40dd3a75ee8a3ebca5f7dbbf6))
* **gmail:** return draft ID from createDraft, not message ID ([cd756df](https://github.com/metaneutrons/eule-mcp/commit/cd756df7af2170a41f0caffc0fbad4e86d1d6fb5))
* **google:** surface per-calendar listEvents failures instead of swallowing ([b0975d2](https://github.com/metaneutrons/eule-mcp/commit/b0975d25af7dfe6e0a0f589e89973e4556dc1ab8))
* harden release please bootstrap ([#27](https://github.com/metaneutrons/eule-mcp/issues/27)) ([5268449](https://github.com/metaneutrons/eule-mcp/commit/52684495c89482d36d14f47a7ea282ebc3dd6c1c))
* **mail:** rfc 2047 encode Subject headers for non-ASCII (umlauts, emoji) ([f03726e](https://github.com/metaneutrons/eule-mcp/commit/f03726efa61b64181491787efc8629e47816a45d))
* **registry:** add google case to getMailConnectorForAccount ([591a6d8](https://github.com/metaneutrons/eule-mcp/commit/591a6d896e11d721d7fe57e77a7cf3a55d8346e7))
* **renderer:** deduplicate reply header from thread body ([79f56e2](https://github.com/metaneutrons/eule-mcp/commit/79f56e26b2f942f0d69815cf220da67d92f3f078))
* **renderer:** split threads in HTML before Markdown conversion ([d6d2a9d](https://github.com/metaneutrons/eule-mcp/commit/d6d2a9df6dcd95c4fdbd59f0b948665c71dd84fb))
* **security:** cap response size on all download paths, not just the iCal feed ([f9f1fd1](https://github.com/metaneutrons/eule-mcp/commit/f9f1fd13f2568559ee2849a59422ee69170de670))
* **security:** escape injection sinks and harden connectors ([a69b1ba](https://github.com/metaneutrons/eule-mcp/commit/a69b1ba8993f050b5b43b5fc5922cc9f00dafd51))
* **server:** sandbox uploads, add FTS query safety and global handlers ([79e2973](https://github.com/metaneutrons/eule-mcp/commit/79e2973f3cf6c4ee981b8709225e23c603c1c278))
* skip empty snippet line in mail_list output ([0200027](https://github.com/metaneutrons/eule-mcp/commit/02000277949138c12a9b6b17687e4732167b88af))
* update tool descriptions to include Google Drive ([75e6710](https://github.com/metaneutrons/eule-mcp/commit/75e6710a5fb860cce5ad21ebea8387ebaad564a0))
