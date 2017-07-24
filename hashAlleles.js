#!/usr/bin/env node

'use strict';
const logger = require('debug');
const { writeAlleleHashes } = require('./pubmlst')

writeAlleleHashes('/code/pubmlst/Staphylococcus_aureus/hashes.json', "Staphylococcus aureus").then(logger('dones'))
