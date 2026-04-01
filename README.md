# Dockit

Desktop app built with React, TypeScript, Vite, and Tauri.

## Download

Prebuilt Linux and macOS binaries are published on the GitHub Releases page:

- Download the latest release from `https://github.com/<owner>/<repo>/releases`
- Each pushed version tag like `v0.1.0` creates a new release with fresh binaries

Replace `<owner>/<repo>` with your actual GitHub repository path.

## Package manager

This repo uses Bun.

## Requirements

- [Bun](https://bun.sh)
- Rust and the Tauri native prerequisites for your platform

## Getting started

```bash
bun install
```

## Development

Run the web app in development mode:

```bash
bun run dev
```

Run the Tauri app:

```bash
bun run tauri dev
```

## Build

Build the frontend bundle:

```bash
bun run build
```

Build the desktop app:

```bash
bun run tauri build
```

## Lint

```bash
bun run lint
```
