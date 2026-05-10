import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, Mail, ShoppingBag } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      if (!response.ok && response.status !== 200) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 400 && data?.error) {
          setError(String(data.error));
        } else {
          setSubmitted(true);
        }
      } else {
        setSubmitted(true);
      }
    } catch (err) {
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#0f1117] relative overflow-hidden px-4">

      {/* Background glows */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-[-15%] left-[-10%] h-[45%] w-[45%] rounded-full bg-amber-500/10 blur-[120px]" />
        <div className="absolute bottom-[-15%] right-[-10%] h-[45%] w-[45%] rounded-full bg-orange-500/8 blur-[120px]" />
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{ backgroundImage: "radial-gradient(circle, #fff 1px, transparent 1px)", backgroundSize: "28px 28px" }}
        />
      </div>

      <div className="relative z-10 w-full max-w-[400px]">

        {/* Brand */}
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-amber-500/30">
            <ShoppingBag className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Reset password</h1>
          <p className="mt-1.5 text-[13px] text-white/50">
            {submitted ? "Check your inbox" : "We'll send a reset link to your email"}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-7 shadow-2xl backdrop-blur-md">

          {submitted ? (
            <div className="space-y-5 text-center" data-testid="forgot-password-confirmation">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30">
                <CheckCircle2 className="h-6 w-6 text-emerald-400" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-white/90">Link sent</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
                  If <span className="font-medium text-white/70">{email}</span> matches an admin account, a reset link has been sent. It expires in 30 minutes and can only be used once.
                </p>
              </div>
              <Link href="/login">
                <button
                  className="w-full rounded-xl border border-white/10 bg-white/[0.05] py-2.5 text-[13px] font-medium text-white/70 hover:bg-white/[0.08] hover:text-white/90 transition-all focus-visible:outline-none"
                  data-testid="button-back-to-login"
                >
                  Return to sign in
                </button>
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">

              {/* Back link */}
              <Link href="/login">
                <a className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white/40 hover:text-white/70 transition-colors focus-visible:outline-none" data-testid="link-back-to-login">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to sign in
                </a>
              </Link>

              <p className="text-[13px] leading-relaxed text-white/45">
                Enter your admin account email and we'll send a single-use reset link. Expires in 30 minutes.
              </p>

              {/* Email */}
              <div className="space-y-1.5">
                <label htmlFor="fp-email" className="block text-[11px] font-semibold uppercase tracking-widest text-white/40">
                  Email address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/25" />
                  <Input
                    id="fp-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-11 rounded-xl border-white/10 bg-white/[0.06] pl-9 text-sm text-white placeholder:text-white/25 focus:border-amber-400/60 focus:ring-amber-400/15 focus:bg-white/[0.08] transition-all"
                    required
                    autoFocus
                    data-testid="input-forgot-email"
                  />
                </div>
              </div>

              {error && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-[13px] text-red-400" data-testid="text-forgot-error">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || !email.trim()}
                className="group flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-[14px] font-bold text-white shadow-lg shadow-amber-500/25 transition-all hover:bg-amber-400 hover:shadow-amber-400/30 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                data-testid="button-send-reset-link"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Send reset link
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-white/20">
          AJKMart Admin &copy; {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
