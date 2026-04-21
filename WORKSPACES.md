# WORKSPACES.md - Workspace Guide

This document describes the workspace structure and conventions for this project.

---

## Project Overview

**TARS** - Task Automation & Response System

A Node.js/TypeScript project for autonomous issue handling and task automation.

---

## Directory Structure

```
tars/
├── src/              # Source code
├── tests/            # Test files
├── .pi/              # Pi agent configuration and session data
├── node_modules/     # Dependencies (git-ignored)
├── AGENTS.md         # Instructions for AI agents
├── SOUL.md           # TARS identity and operating principles
├── WORKSPACES.md     # This file - workspace documentation
├── README.md         # Project overview
├── package.json      # Node.js dependencies and scripts
├── tsconfig.json     # TypeScript configuration
└── .env.example      # Environment variable template
```

---

## Key Files

| File | Purpose |
|------|---------|
| `SOUL.md` | TARS identity, core traits, and operating principles |
| `AGENTS.md` | Session startup instructions for AI agents |
| `WORKSPACES.md` | Workspace structure and conventions (this file) |
| `package.json` | Dependencies and npm scripts |
| `tsconfig.json` | TypeScript compiler options |

---

## Development Conventions

### Source Code
- Location: `src/`
- Language: TypeScript
- Entry point: Defined in `package.json`

### Tests
- Location: `tests/`
- Framework: Defined in `package.json`

### Configuration
- Environment variables: Copy `.env.example` to `.env`
- Pi agent config: `.pi/` directory

---

## Agent Workflow

1. **Session Start**: Read `SOUL.md` and `AGENTS.md`
2. **Check Issues**: Query assigned open issues
3. **Execute Tasks**: Work through issues autonomously
4. **Report**: Comment on issues with progress/completion

---

## Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
```

---

*Created: 2026-04-21*
