# AGENTS.md

本文件是本仓库的协作约定。所有在此仓库中工作的 Agent（以及人类），请遵守以下规则。

## 注意事项

1. **每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。**

   - 一次逻辑改动 = 一个 commit，不要把多次无关的改动混在一个 commit 里。
   - commit message 用约定式格式：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`。
   - 不要提交密钥、凭据、本地绝对路径等敏感内容。

2. **每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。**

   - 改动行为就补/改对应的测试；新增功能必须有测试覆盖。
   - 交付前跑一遍完整测试与验证，全绿才算完成。
   - 有测试失败的，先修到通过，再汇报结果，不要把红灯甩给用户。

---

## 发布清单（桌面版）

打 `v*.*.*` tag 触发 `release.yml` 编译 macOS 通用 dmg 并上传 Releases。每次发布前确认：

1. **版本号跟随 tag**：Tauri 打包文件名 = `{productName}_{conf.version}_{target}.dmg`，**不自动读 git tag**。若 `tauri.conf.json` 的 `version` 写死，产物名会停在旧版本（例如打 `v0.1.1` 却出 `ebook-reader_0.1.0_universal.dmg`）。`release.yml` 已在打包前用 `GITHUB_REF_NAME`（去 v 前缀）覆盖 `conf.version`——改动打包流程后务必保留这步，否则文件名与 tag 脱节。
2. **双通道互不干扰**：桌面版只认 tag 触发，push main 不会跑，网页版 `deploy-pages.yml` 不受影响。
3. **未签名说明就位**：README 已写清 Gatekeeper 放行方式（系统设置仍要打开 / 右键打开 / `xattr -cr`），用户不会误以为中病毒。

---

_本文件由主上大人钦定，2026-09-08 立。_
