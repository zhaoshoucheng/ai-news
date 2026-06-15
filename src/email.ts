/**
 * 邮件推送模块
 *
 * 通过 SMTP 发送 AI 模型变更报告邮件。
 * 为了零额外依赖，底层调用系统 Python 的 smtplib 完成 SMTP 投递。
 *
 * 所需环境变量（写在 .env，不进入 git）：
 *   SMTP_HOST      SMTP 服务器地址，默认 smtp.gmail.com
 *   SMTP_PORT      SMTP 端口，默认 465（SSL）
 *   SMTP_USER      发件邮箱账号
 *   SMTP_PASS      SMTP 授权码 / 应用专用密码
 *   MAIL_FROM      发件显示地址，默认等于 SMTP_USER
 *   MAIL_TO        收件邮箱，可逗号分隔多个
 */

import { spawnSync } from "child_process";

export interface MailOptions {
  subject: string;
  /** Markdown 正文，会自动转为简单 HTML */
  markdown: string;
}

/**
 * 发送邮件。失败时降级为控制台输出（用于本地开发或缺少配置时）。
 */
export async function sendEmail(opts: MailOptions): Promise<void> {
  const host = process.env.SMTP_HOST ?? "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT ?? "465");
  const user = process.env.SMTP_USER ?? "";
  const pass = process.env.SMTP_PASS ?? "";
  const from = process.env.MAIL_FROM ?? user;
  const to = process.env.MAIL_TO ?? user;

  if (!user || !pass) {
    console.warn("[Email] SMTP_USER / SMTP_PASS 未配置，降级输出到控制台：");
    console.log("─".repeat(60));
    console.log(`Subject: ${opts.subject}`);
    console.log(opts.markdown);
    console.log("─".repeat(60));
    return;
  }

  const html = markdownToHtml(opts.markdown);

  const payload = JSON.stringify({
    host,
    port,
    user,
    pass,
    from,
    to,
    subject: opts.subject,
    text: opts.markdown,
    html,
  });

  const result = spawnSync("python3", ["-c", PY_SEND_SCRIPT], {
    input: payload,
    encoding: "utf-8",
    timeout: 60000,
  });

  if (result.status === 0) {
    console.log(`[Email] 邮件已发送至 ${to}`);
  } else {
    const err = (result.stderr || result.stdout || "unknown error").trim();
    console.warn(`[Email] 发送失败 (${err})，降级输出到控制台：`);
    console.log("─".repeat(60));
    console.log(`Subject: ${opts.subject}`);
    console.log(opts.markdown);
    console.log("─".repeat(60));
  }
}

/**
 * 极简 Markdown -> HTML 转换。
 * 支持标题、加粗、斜体、链接、列表、分隔线、换行，满足报告排版需求。
 */
function markdownToHtml(md: string): string {
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;

  const inline = (text: string): string => {
    let t = escapeHtml(text);
    // 链接 [text](url)
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    // 裸链接
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
    // 加粗
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // 斜体
    t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    // 行内代码
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    return t;
  };

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      closeList();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const level = (line.match(/^#+/) ?? ["#"])[0].length;
      const content = line.replace(/^#+\s/, "");
      out.push(`<h${level}>${inline(content)}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      out.push("<hr/>");
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul style="margin:8px 0;padding-left:20px;">');
        inList = true;
      }
      const content = line.replace(/^\s*[-*•]\s+/, "");
      out.push(`<li style="margin:4px 0;">${inline(content)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p style="margin:8px 0;line-height:1.6;">${inline(line)}</p>`);
  }
  closeList();

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto;padding:16px;">
${out.join("\n")}
<hr/>
<p style="color:#888;font-size:12px;">本邮件由 AI Model Monitor 自动生成。</p>
</body></html>`;
}

// 内嵌 Python SMTP 发送脚本：从 stdin 读取 JSON，使用 SSL 或 STARTTLS 发送
const PY_SEND_SCRIPT = `
import sys, json, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate

data = json.load(sys.stdin)
host = data["host"]; port = int(data["port"])
user = data["user"]; pwd = data["pass"]
sender = data.get("from") or user
to_raw = data.get("to") or user
recipients = [a.strip() for a in to_raw.split(",") if a.strip()]

msg = MIMEMultipart("alternative")
msg["Subject"] = data["subject"]
msg["From"] = formataddr(("AI Model Monitor", sender))
msg["To"] = ", ".join(recipients)
msg["Date"] = formatdate(localtime=True)
msg.attach(MIMEText(data.get("text", ""), "plain", "utf-8"))
msg.attach(MIMEText(data.get("html", ""), "html", "utf-8"))

try:
    if port == 465:
        server = smtplib.SMTP_SSL(host, port, timeout=45)
    else:
        server = smtplib.SMTP(host, port, timeout=45)
        server.starttls()
    server.login(user, pwd)
    server.sendmail(sender, recipients, msg.as_string())
    server.quit()
    print("OK")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
