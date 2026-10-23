import { PRODUCT_NAME } from "@vns/shared";

export default function Home() {
  return (
    <main className="shell">
      <span className="eyebrow">P1 · Foundation</span>
      <h1>{PRODUCT_NAME}</h1>
      <p>
        The isolated production studio is being built. Research, rendering, and uploads are
        not active in this scaffold.
      </p>
      <div className="notice" role="status">
        No autonomous publication. Human editorial approval is required.
      </div>
    </main>
  );
}
