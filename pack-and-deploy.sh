#!/bin/bash

rm -f FunctionCode.zip
zip -r FunctionCode.zip . -x "node_modules/*" -x ".*" -x "local.*" -x "README.md" -x "pack-and-deploy.sh"

az functionapp deployment source config-zip \
    --name khs-website-health-check \
    --resource-group khs-website \
    --src FunctionCode.zip
