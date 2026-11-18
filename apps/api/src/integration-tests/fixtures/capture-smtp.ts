import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";

/** A loopback-only mailbox for the Nodemailer SMTP transport in integration tests. */
export async function captureSmtp() {
  const messages: Array<{ recipient: string; data: string }> = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let recipient = "";
    let data: string[] | undefined;
    const reply = (line: string) => socket.write(line + "\r\n");

    lines.on("line", line => {
      if (data) {
        if (line !== ".") {
          data.push(line.startsWith("..") ? line.slice(1) : line);
          return;
        }
        messages.push({ recipient, data: data.join("\r\n") });
        data = undefined;
        reply("250 Message accepted");
        return;
      }
      if (/^(?:EHLO |HELO |MAIL FROM:)/i.test(line)) {
        reply("250 localhost");
      } else if (line.startsWith("RCPT TO:")) {
        recipient = line.slice("RCPT TO:".length);
        reply("250 Recipient accepted");
      } else if (line === "DATA" && recipient) {
        data = [];
        reply("354 Send message");
      } else if (line === "QUIT") {
        socket.end("221 Closing connection\r\n");
      } else {
        reply("500 Unexpected command");
      }
    });
    reply("220 localhost");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP fixture must use TCP");
  return {
    port: address.port,
    messages,
    async close() {
      const closed = once(server, "close");
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
