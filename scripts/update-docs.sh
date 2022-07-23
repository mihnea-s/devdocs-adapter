#!/usr/bin/env bash
#
# This script automatically updates the `src/data/docs.json` file.
#
# That file contains names, slugs and links for the docsets available
# on devdocs.io, technically it is not needed as you can just set slugs
# manually with `devdocs-adapter.docsets`, but it is nice to have an
# up to date version.
#
# This script requires:
#   - curl
#   - ripgrep
#   - node
#   - jq
#   - git (optionally)
#

set -e

DOCSJS_PATH=$(curl 'https://devdocs.io/' | rg '^.*?<script src="((/\w+)+/docs-[a-f\d]+.js)"></script>.*?$' -r '$1')
DOCSJS_PATH="https://devdocs.io$DOCSJS_PATH"

curl -L "$DOCSJS_PATH"                                     \
    | sed                                                  \
        -e '1s|^app\.DOCS =|console.log(JSON.stringify(|'  \
        -e '$s|;$|));|'                                    \
    | node                                                 \
    | jq .                                                 \
    > src/data/docs.json

read -r -p "Do you want to commit the update? [y/N] " MAKE_COMMIT

if [[ $MAKE_COMMIT =~ ^[Yy]$ ]]; then
    git add src/data/docs.json
    git commit -m "chore: Update docset manifests $(date -u +'%d/%m/%Y')"
fi

echo "Done."
