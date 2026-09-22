#!/usr/bin/env node
/** 按环境启动：node scripts/run-env.js local|test|prod */
const env = String(process.argv[2] || 'local').trim().toLowerCase();
const file = {
  local: '.env.local',
  test: '.env.test',
  prod: '.env.prod',
  production: '.env.prod',
}[env];

if (!file) {
  console.error('usage: node scripts/run-env.js local|test|prod');
  process.exit(1);
}

process.env.APP_ENV = env === 'prod' ? 'production' : env;
process.env.ENV_FILE = file;
require('../src/index.js');
