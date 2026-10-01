# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-01

### Added

- `/nimble-compact` runs output pruning on demand while preserving evidence protections and the cache-payback gate.

### Changed

- Quick start installs the published npm package, and the README documents manual pruning.

### Fixed

- Keep unrelated historical tool calls from exhausting Nimble's scoring-history budget, and stop showing Ollama setup advice for unrelated failures.

## [0.1.0] - 2026-10-01

First release.

### Added

- CI checks and a documented stable-release publishing process using npm trusted publishing.

### Changed

- Use the unscoped npm package name `pi-nimble-compact`.

[unreleased]: https://github.com/SirDarcanos/pi-nimble-compact/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SirDarcanos/pi-nimble-compact/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SirDarcanos/pi-nimble-compact/releases/tag/v0.1.0
