module.exports = {
  apps: [
    {
      name: "telegram-terminal-bot",
      script: "scripts/termbot-supervisor.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
