#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const XRAY_BIN = "/usr/local/bin/xray";
const CONFIG_PATH = "/usr/local/etc/xray/config.json";
const INFO_PATH = "/root/vless_reality_info.txt";

const COLOR = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

function info(msg) {
  console.log(COLOR.green("[信息] ") + msg);
}
function warn(msg) {
  console.log(COLOR.yellow("[警告] ") + msg);
}
function fail(msg) {
  console.log(COLOR.red("[错误] ") + msg);
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function ask(question, defaultValue) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [默认 ${defaultValue}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function main() {
  // 0. 环境检查
  if (process.getuid && process.getuid() !== 0) {
    fail("请使用 root 用户运行：sudo node index.js");
  }
  if (!fs.existsSync(XRAY_BIN)) {
    fail(
      "未检测到 Xray，请先安装：\n" +
        "bash <(curl -Ls https://raw.githubusercontent.com/XTLS/Xray-install/main/install-release.sh) install"
    );
  }

  const version = run(`${XRAY_BIN} version`).split("\n")[0];
  info(`检测到 Xray：${version}`);

  // 1. 生成 UUID
  const uuid = run(`${XRAY_BIN} uuid`);
  info(`生成 UUID：${uuid}`);

  // 2. 生成 X25519 密钥对
  const keyOutput = run(`${XRAY_BIN} x25519`);
  const privateKeyMatch = keyOutput.match(/Private key:\s*(\S+)/);
  const publicKeyMatch = keyOutput.match(/Public key:\s*(\S+)/);
  if (!privateKeyMatch || !publicKeyMatch) {
    fail("解析密钥对失败，请检查 xray 版本是否支持 x25519 命令");
  }
  const privateKey = privateKeyMatch[1];
  const publicKey = publicKeyMatch[1];
  info("生成 Reality 密钥对完成");

  // 3. 生成 Short ID
  const shortId = run("openssl rand -hex 8");

  // 4. 交互式配置
  const port = await ask("请输入监听端口", "443");

  console.log("\n请选择伪装目标网站 (SNI)：");
  console.log("  1) www.microsoft.com  (默认)");
  console.log("  2) www.apple.com");
  console.log("  3) www.amazon.com");
  console.log("  4) 自定义");
  const sniChoice = await ask("请输入选项 [1-4]", "1");

  let dest;
  switch (sniChoice) {
    case "2":
      dest = "www.apple.com";
      break;
    case "3":
      dest = "www.amazon.com";
      break;
    case "4":
      dest = await ask("请输入自定义域名");
      break;
    default:
      dest = "www.microsoft.com";
  }

  // 5. 生成配置对象
  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        listen: "0.0.0.0",
        port: Number(port),
        protocol: "vless",
        settings: {
          clients: [{ id: uuid, flow: "xtls-rprx-vision" }],
          decryption: "none",
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            show: false,
            dest: `${dest}:443`,
            xver: 0,
            serverNames: [dest],
            privateKey: privateKey,
            shortIds: [shortId],
          },
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls"],
        },
      },
    ],
    outbounds: [
      { protocol: "freedom", tag: "direct" },
      { protocol: "blackhole", tag: "block" },
    ],
  };

  // 6. 写入配置文件
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  info(`配置文件已写入：${CONFIG_PATH}`);

  // 7. 防火墙放行（存在则执行，不存在则忽略）
  try {
    run(`command -v ufw && ufw allow ${port}/tcp`);
  } catch (_) {}
  try {
    run(
      `command -v firewall-cmd && firewall-cmd --permanent --add-port=${port}/tcp && firewall-cmd --reload`
    );
  } catch (_) {}

  // 8. 重启服务
  try {
    run("systemctl daemon-reload");
    run("systemctl enable xray");
    run("systemctl restart xray");
  } catch (e) {
    fail("启动 xray 服务失败，请运行 journalctl -u xray -e 查看日志");
  }

  await new Promise((r) => setTimeout(r, 1500));

  let active = false;
  try {
    active = run("systemctl is-active xray") === "active";
  } catch (_) {}

  if (!active) {
    fail("Xray 服务未正常运行，请运行 journalctl -u xray -e 查看日志");
  }
  info("Xray 服务运行正常");

  // 9. 获取服务器 IP
  let serverIp;
  try {
    serverIp = run("curl -s4 ifconfig.me || curl -s4 icanhazip.com");
  } catch (_) {
    serverIp = "<你的服务器IP>";
  }

  const nodeName = `VLESS-Reality-${serverIp}`;
  const shareLink =
    `vless://${uuid}@${serverIp}:${port}?encryption=none&flow=xtls-rprx-vision` +
    `&security=reality&sni=${dest}&fp=chrome&pbk=${publicKey}&sid=${shortId}` +
    `&type=tcp&headerType=none#${encodeURIComponent(nodeName)}`;

  // 10. 输出结果
  console.log("\n" + "=".repeat(66));
  console.log(COLOR.green("          VLESS + REALITY 安装配置完成！"));
  console.log("=".repeat(66));
  console.log(`服务器 IP    : ${serverIp}`);
  console.log(`端口         : ${port}`);
  console.log(`UUID         : ${uuid}`);
  console.log(`Flow         : xtls-rprx-vision`);
  console.log(`加密方式     : none`);
  console.log(`传输协议     : tcp`);
  console.log(`安全类型     : reality`);
  console.log(`SNI          : ${dest}`);
  console.log(`Public Key   : ${publicKey}`);
  console.log(`Private Key  : ${privateKey}  (仅服务端保留，不要泄露)`);
  console.log(`Short ID     : ${shortId}`);
  console.log("-".repeat(66));
  console.log("分享链接：");
  console.log(shareLink);
  console.log("-".repeat(66));

  // 尝试用 qrencode 输出二维码（若系统已安装）
  try {
    console.log("二维码：");
    console.log(run(`qrencode -t ANSIUTF8 "${shareLink}"`));
  } catch (_) {
    warn("未检测到 qrencode，可运行 apt/yum install qrencode 后自行生成二维码");
  }
  console.log("=".repeat(66) + "\n");

  // 11. 保存信息
  const infoText = [
    `服务器 IP    : ${serverIp}`,
    `端口         : ${port}`,
    `UUID         : ${uuid}`,
    `Flow         : xtls-rprx-vision`,
    `SNI          : ${dest}`,
    `Public Key   : ${publicKey}`,
    `Private Key  : ${privateKey}`,
    `Short ID     : ${shortId}`,
    `分享链接     : ${shareLink}`,
  ].join("\n");

  fs.writeFileSync(INFO_PATH, infoText, "utf8");
  info(`配置信息已保存到 ${INFO_PATH}`);
}

main().catch((err) => {
  fail(err.message || String(err));
});
