module.exports = {
  apps: [
    {
      name: "telegram-terminal-bot",
      script: "bot.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
