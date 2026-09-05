#!/usr/bin/env node
/** Run server with ENV_FILE=.env.test */
process.env.ENV_FILE = process.env.ENV_FILE || '.env.test';
require('../src/index.js');
