import { RpcTarget, newMessagePortRpcSession } from "capnweb";

const input = document.querySelector<HTMLInputElement>("input")!;
const error = document.querySelector<HTMLElement>("[role=status]")!;
let host: any;
class Frame extends RpcTarget {
  async collectResourceUrl() {
    return host.gatekeeper.validate(input.value);
  }
  updateViewport(_top: number, _height: number) {}
  windowResized() {}
}
async function main() {
  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  host = newMessagePortRpcSession(port1, new Frame());
  const initial = await host.getInitialResource();
  const pattern = await host.gatekeeper.pattern();
  input.value = initial?.resourceUrl ?? (pattern === "https://www.canva.com/" ? pattern : "");
  input.placeholder = pattern.includes("folder")
    ? "https://www.canva.com/folder/…"
    : "https://www.canva.com/design/…/edit";
  const ready = () => {
    error.textContent = "";
    host.setSelectionReady(input.value.trim().length > 0);
  };
  input.addEventListener("input", ready);
  ready();
  host.resize(148, 148);
}
main().catch(() => {
  error.textContent = "Could not open the resource selector. Close it and try again.";
});
