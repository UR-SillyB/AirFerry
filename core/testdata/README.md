# core/testdata — 跨端 golden vectors

Rust / Android (Kotlin) / Windows (C#) 测试断言**同一份** fixture，是跨端线格式一致性的实际保障。修改线格式属于协议变更，必须同步更新 `af2/manifest.json` 与三端断言。

## 目录

- `af2/manifest.json` — AF2 协议 golden index（根记录 / Object Meta / Symbol 帧 / 三层 ID / BLAKE3 空哈希，全部 hex 承载）

## manifest.json 顶层字段

| 字段 | 内容 |
|---|---|
| `protocol` / `schema` | 协议标识与索引格式版本 |
| `blake3_empty_hash` | BLAKE3 空输入哈希（`core/af2::id::empty_hash`） |
| `root_record_hex` / `root_frame_hex` | Root Record 及完整帧 hex |
| `object_meta_record_hex` / `object_meta_frame_hex` | Object Meta Record 及完整帧 hex |
| `symbol_frame_hex` | Symbol 数据帧 hex |
| `three_ids` | Content / Transfer / Object 三层 ID 期望推导 |

JSON 数字安全上限 2^53，所有 u64 一律以 hex 字符串承载。

## 三端断言位置

| 端 | 测试 | 覆盖面 |
|---|---|---|
| Rust | `core/af2/tests/golden_vectors.rs` | 帧头/根记录/Meta/三层 ID 推导/BLAKE3 空哈希（全量往返，唯一权威） |
| Android | `apps/scanner/app/src/test/java/com/airferry/app/Af2GoldenVectorTest.kt` | 帧头解析、ID 推导 |
| Windows | `apps/windows/AirFerry.Windows.Tests/Af2GoldenVectorTests.cs` | 帧头解析、ID 推导 |
| Web | `apps/web/test/golden-vectors.test.mjs`（`npm test`） | 帧头解析、ID 宽度、线常量 |

三端宿主只做帧头级断言（协议语义收敛在 Rust，宿主仅路由帧）；完整记录/ID 往返校验由 Rust 侧独占。

## 更新流程

1. 修改线格式后同步 hex 字段（保持确定性）；
2. 四端断言同步跑 `cargo test --workspace`、`cd apps/scanner && ./gradlew :app:testDebugUnitTest`、`dotnet test apps/windows/AirFerry.Windows.Tests`、`cd apps/web && npm test`。