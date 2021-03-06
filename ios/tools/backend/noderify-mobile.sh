#!/bin/bash

# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

set -eEu -o pipefail
shopt -s extdebug
IFS=$'\n\t'
trap 'onFailure $?' ERR

function onFailure() {
  echo "Unhandled script error $1 at ${BASH_SOURCE[0]}:${BASH_LINENO[0]}" >&2
  exit 1
}

# Why some packages are filter'd or replaced:
#   bindings: after noderify, the paths to .node files might be different, so
#      we use a special fork of bindings
#   chloride: needs special compilation configs for android, and we'd like to
#      remove unused packages such as sodium-browserify etc
#   leveldown: newer versions of leveldown are intentionally ignoring
#      nodejs-mobile support, so we run an older version
#   utp-native: we want to compile for nodejs-mobile instead of using prebuilds
#   node-extend: can't remember why we need to replace it, build seemed to fail
#   non-private-ip: we use a "better" fork of this package
#   multiserver net plugin: we're fixing a corner case bug with error recovery
#   rn-bridge: this is not an npm package, it's just a nodejs-mobile shortcut
#   bl: we didn't use it, and bl@0.8.x has security vulnerabilities
#   bufferutil: because we want nodejs-mobile to load its native bindings
#   supports-color: optional dependency within package `debug`
#   utf-8-validate: because we want nodejs-mobile to load its native bindings
mkdir -p out/
$(npm bin)/noderify \
  --replace.bindings=bindings-noderify-nodejs-mobile \
  --replace.chloride=sodium-chloride-native-nodejs-mobile \
  --replace.leveldown=leveldown-nodejs-mobile \
  --replace.utp-native=utp-native-nodejs-mobile \
  --replace.node-extend=xtend \
  --replace.non-private-ip=non-private-ip-android \
  --replace.multiserver/plugins/net=staltz-multiserver/plugins/net \
  --filter=rn-bridge \
  --filter=bl \
  --filter=bufferutil \
  --filter=supports-color \
  --filter=utf-8-validate \
  --filter=bip39/src/wordlists/chinese_simplified.json \
  --filter=bip39/src/wordlists/chinese_traditional.json \
  --filter=bip39/src/wordlists/french.json \
  --filter=bip39/src/wordlists/italian.json \
  --filter=bip39/src/wordlists/japanese.json \
  --filter=bip39/src/wordlists/korean.json \
  --filter=bip39/src/wordlists/spanish.json \
  backend/index.js > out/index.js;