'use strict';
const { convert } = require('./converter');

process.on('message', async msg => {
  if (msg.type !== 'start') return;
  try {
    await convert(msg.opts, payload => {
      // Route log lines to stdout so main.js can forward to renderer
      if (payload.type === 'log') {
        const prefix = { completion: '[+]', process: '[•]', error: '[ERROR]', critical: '[X]' }[payload.logType] || '[•]';
        process.stdout.write(prefix + ' ' + payload.msg + '\n');
      } else {
        process.send(payload);
      }
    });
    process.exit(0);
  } catch (e) {
    process.stderr.write('[ERROR] ' + e.message + '\n');
    process.exit(1);
  }
});
