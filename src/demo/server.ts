import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const layout = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="windows-1252">
    <title>${title}</title>
    <style>
      body { background: #d6d2c4; color: #111; font: 14px Arial, sans-serif; margin: 8px; }
      table.panel { border: 2px outset #fff; background: #ece9d8; width: 100%; }
      th { background: #153b67; color: white; text-align: left; padding: 5px; }
      td { padding: 6px; }
      input, button { font: inherit; }
      .message { border: 1px solid #7c6f3d; background: #fff8cc; padding: 10px; margin: 8px 0; }
      .error { border-color: #8b1a1a; background: #ffe2e2; }
      .modal { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.45); }
      .dialog { background: #ece9d8; border: 3px outset #fff; max-width: 440px; padding: 16px; }
      .money { font-family: monospace; font-weight: bold; }
      .sr-only { position:absolute; left:-9999px; }
    </style>
  </head>
  <body>${body}${script ? `<script>${script}</script>` : ""}</body>
</html>`;

const outerPage = `<!doctype html>
<html lang="en">
  <head><title>Meridian Core 2004</title></head>
  <frameset rows="68,*" frameborder="1">
    <frame name="navigation" title="Application navigation" src="/nav">
    <frame name="main" title="Workspace" src="/members">
  </frameset>
</html>`;

const navPage = layout(
  "Navigation",
  `<table class="panel"><tr><th>MERIDIAN CORE 2004</th></tr><tr><td>
    <a href="/members" target="main">Member inquiry</a> |
    <a href="/maintenance" target="main">Maintenance</a>
  </td></tr></table>`,
);

const membersPage = layout(
  "Member Inquiry",
  `<form action="/member-result" method="get">
    <table class="panel" summary="Member inquiry form">
      <tr><th colspan="2">MEMBER INQUIRY</th></tr>
      <tr>
        <td><label for="mbr_ref">Member ID</label></td>
        <td><input id="mbr_ref" name="id" inputmode="numeric" autocomplete="off" data-sensitive="true"></td>
      </tr>
      <tr><td></td><td><button type="submit">Search</button></td></tr>
    </table>
  </form>
  <p>Authorized staff use only. Synthetic demonstration records.</p>`,
);

const memberRecord = (id: string, balance = "$4,281.73") => `
  <table class="panel" summary="Member details">
    <tr><th colspan="2"><h1 style="font-size:16px;margin:0">Member details</h1></th></tr>
    <tr><td>Member ID</td><td data-sensitive="true">${id}</td></tr>
    <tr><td>Name</td><td data-sensitive="true">Demo Member</td></tr>
    <tr><td>Share savings balance</td><td><span class="money" role="status" data-sensitive="true" aria-label="Savings balance">${balance}</span></td></tr>
  </table>
  <p><a href="/members">New inquiry</a></p>`;

const resultPage = (url: URL) => {
  const id = url.searchParams.get("id") ?? "";
  const recovered = url.searchParams.get("recovered") === "1";

  if (id === "99999") {
    return layout(
      "Member Not Found",
      `<div class="message business-error" role="alert">No member found for the supplied identifier.</div>
       <a href="/members">Return to inquiry</a>`,
    );
  }

  if (id === "88888") {
    return layout(
      "Permission Denied",
      `<div class="message error permission-error" role="alert">Permission denied: member record is restricted.</div>
       <a href="/members">Return to inquiry</a>`,
    );
  }

  if (id === "55555" && !recovered) {
    return layout(
      "Session Expired",
      `<div class="modal session-expired" role="dialog" aria-label="Session expired">
         <div class="dialog"><h1>Session expired</h1><p>Your session timed out while loading the record.</p>
         <button onclick="location.href='/member-result?id=55555&recovered=1'">Resume session</button></div>
       </div>`,
    );
  }

  if (id === "77777") {
    return layout(
      "Member Details - Verification",
      `<div id="record" hidden>${memberRecord(id, "$739.20")}</div>
       <div class="modal verification-required" role="dialog" aria-label="Operator verification required">
         <div class="dialog"><h1>Operator verification required</h1>
         <p>Identity verification must be completed by an authorized operator.</p>
         <button id="verify">Operator: verification complete</button></div>
       </div>`,
      `document.getElementById('verify').addEventListener('click', function () {
        document.querySelector('.verification-required').remove();
        document.getElementById('record').hidden = false;
      });`,
    );
  }

  return layout("Member Details", memberRecord(id || "12345"));
};

export interface DemoServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startDemoServer(port = 4318): Promise<DemoServer> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let html: string;
    let status = 200;

    switch (url.pathname) {
      case "/":
        html = outerPage;
        break;
      case "/nav":
        html = navPage;
        break;
      case "/members":
        html = membersPage;
        break;
      case "/member-result":
        html = resultPage(url);
        break;
      case "/maintenance":
        html = layout("Maintenance", `<div class="message">This action is disabled in the demo.</div>`);
        break;
      case "/health":
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      default:
        status = 404;
        html = layout("Not Found", `<div class="message error">Page not found.</div>`);
    }

    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "SAMEORIGIN",
    });
    response.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
