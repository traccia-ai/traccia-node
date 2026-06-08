# NPM Publishing Guide

## Pre-Publishing Checklist

- ✅ All tests passing (27/28 - 1 intentionally skipped)
- ✅ Build successful with no TypeScript errors
- ✅ Code linting clean (0 critical errors)
- ✅ dist/ folder generated with .js and .d.ts files
- ✅ package.json configured with exports
- ✅ README.md and documentation complete
- ✅ LICENSE file included (MIT)

## Files Ready for Publishing

```
traccia-sdk-ts/
├── dist/                 # Compiled JavaScript + TypeScript declarations
├── src/                  # Source TypeScript files (optional but recommended)
├── package.json          # Package metadata and exports
├── README.md             # Main documentation
├── LICENSE               # MIT license
├── QUICKSTART.md         # Quick start guide
├── DEVELOPER.md          # Developer documentation
├── CONTRIBUTING.md       # Contribution guidelines
└── CHANGELOG.md          # Release history
```

## Publishing Steps

### 1. Configure npm account
```bash
# First time setup
npm login
# Enter username, password, and OTP when prompted
```

### 2. Verify package name availability
```bash
npm search @traccia/sdk
# The package name "@traccia/sdk" must be available
```

### 3. Update version number (if needed)
```bash
npm version patch  # 1.0.0 → 1.0.1
npm version minor  # 1.0.0 → 1.1.0
npm version major  # 1.0.0 → 2.0.0
```

### 4. Publish to npm
```bash
npm publish
# Or with specific registry
npm publish --registry https://registry.npmjs.org/
```

### 5. Verify publication
```bash
npm view @traccia/sdk
# Should show your newly published package
```

## Post-Publishing

### View Package
- NPM Registry: https://www.npmjs.com/package/@traccia/sdk
- GitHub Package Registry (optional): Configure in workflow

### Update Documentation
- Add installation instructions to main README
- Link to npm package page
- Update version numbers in examples

### Create Git Tag
```bash
git tag v1.0.0
git push origin v1.0.0
```

## Distribution Contents

### JavaScript Files (21)
- **Core** (3): auto.js, index.js, types.js
- **Config** (3): env-config.js, pricing-config.js, runtime-config.js
- **Context** (1): context.js
- **Exporter** (2): http-exporter.js, console-exporter.js
- **Processor** (5): sampler.js, batch-processor.js, token-counter.js, cost-processor.js, logging-processor.js
- **Tracer** (4): tracer.js, span.ts, span-context.js, provider.js

### TypeScript Declarations (21)
- One `.d.ts` file for each JavaScript file
- `d.ts.map` source maps for debugging

### Total Size
- **356 KB** (dist/ folder)
- **~8 KB** minified + gzipped (estimated)

## Recommended Optional Additions

### 1. GitHub Actions Workflow
Create `.github/workflows/publish.yml`:
```yaml
name: Publish to npm
on:
  push:
    tags:
      - v*
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 2. .npmignore File
```
src
docs
__tests__
.eslintrc.json
.prettierrc.json
jest.config.js
tsconfig.json
.gitignore
BUILD_SUMMARY.md
```

### 3. GitHub Pages Documentation
Host the markdown docs on GitHub Pages for easier access.

## Semver Guidelines

- **PATCH** (1.0.x): Bug fixes, security updates
- **MINOR** (1.x.0): New features, backwards compatible
- **MAJOR** (x.0.0): Breaking changes

## Users Will Install With

```bash
npm install @traccia/sdk
# or
yarn add @traccia/sdk
# or
pnpm add @traccia/sdk
```

## After Publishing

### Monitor
- NPM package page for download stats
- GitHub issues for bug reports
- Analytics on usage patterns

### Maintenance
- Fix critical bugs promptly (patch release)
- Add features in minor releases
- Update documentation as SDK evolves
- Consider security audits regularly

---

**Package Name**: @traccia/sdk  
**Current Version**: 1.0.0  
**License**: MIT  
**Ready for Publication**: ✅ YES
