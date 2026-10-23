import { notFound } from "next/navigation";
import { adminProxyConfig } from "../../../lib/admin-proxy";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  if (!adminProxyConfig(process.env)) notFound();

  return (
    <main className="shell">
      <span className="eyebrow">P1 · Internal admin preview</span>
      <h1>Admin-Anmeldung</h1>
      <p>Nur für den später freigegebenen internen Testbetrieb. Noch kein öffentlicher Zugriff.</p>
      <LoginForm />
    </main>
  );
}
