#!/bin/bash
set -e

# Usage: ./scripts/bump-version.sh 0.2.0

VERSION="${1:?Usage: bump-version.sh <version>}"

echo "Bumping all packages to v${VERSION}..."

# Update all package.json files
for pkg in packages/sdk packages/relay packages/openclaw-plugin packages/shieldcortex-bridge; do
  if [ -f "$pkg/package.json" ]; then
    node -e "
      const fs = require('fs');
      const path = '$pkg/package.json';
      const pkg = JSON.parse(fs.readFileSync(path, 'utf-8'));
      pkg.version = '${VERSION}';
      fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    "
    echo "  Updated $pkg/package.json"
  fi
done

echo ""
echo "Done. Next steps:"
echo "  1. Update CHANGELOG.md"
echo "  2. git add -A && git commit -m 'chore: bump to v${VERSION}'"
echo "  3. git tag v${VERSION}"
echo "  4. git push origin main --tags"
