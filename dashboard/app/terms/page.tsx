import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms of Service for using Tallei.",
  alternates: {
    canonical: "https://tallei.com/terms",
  },
};

const sectionStyle = { marginBottom: "1.5rem" } as const;
const sectionTitleStyle = { fontSize: "1.25rem", marginBottom: "0.5rem", color: "#1a1816" } as const;
const listStyle = { paddingLeft: "1.25rem", marginTop: "0.5rem", color: "#4c4643" } as const;

export default function TermsPage() {
  return (
    <main className="main-content" style={{ background: "#fdfbf7", paddingBottom: "5rem" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 2rem" }}>
        <article
          className="solid-card"
          style={{ padding: "2.25rem", borderColor: "#1a1816", boxShadow: "6px 6px 0 rgba(0, 0, 0, 0.08)" }}
        >
          <h1 style={{ fontSize: "2.2rem", marginBottom: "0.75rem", color: "#1a1816" }}>Terms of Service</h1>
          <p style={{ marginBottom: "2rem", color: "#4c4643", fontSize: "0.95rem" }}>
            Last updated: April 19, 2026
          </p>
          <p style={{ marginBottom: "1rem" }}>
            These Terms of Service govern your access to and use of the Tallei website, applications, APIs, and related
            services (collectively, the Service). By using the Service, you agree to these Terms.
          </p>
          <p style={{ marginBottom: "2rem" }}>
            Your use of the Service is also subject to our privacy policy. If you do not agree to these Terms, you must not
            use the Service.
          </p>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>1. What These Terms Cover</h2>
            <p>
              These Terms apply to your access and use of https://tallei.com, all associated software and documentation, and
              all features, content, and functionality provided by Tallei.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>2. Eligibility and Accounts</h2>
            <p>You must be at least 18 years old to use the Service.</p>
            <p style={{ marginTop: "0.5rem" }}>
              You are responsible for maintaining accurate account information, safeguarding your credentials, and all activity
              under your account.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              If you suspect unauthorized access, contact us immediately at{" "}
              <a href="mailto:hello@tallei.com" style={{ textDecoration: "underline", color: "#1a1816" }}>
                hello@tallei.com
              </a>
              .
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>3. License and Acceptable Use</h2>
            <p>
              Subject to these Terms, we grant you a limited, revocable, non-exclusive, non-transferable license to use the
              Service.
            </p>
            <p style={{ marginTop: "0.5rem" }}>You must not:</p>
            <ul style={listStyle}>
              <li>Resell, lease, sublicense, or commercially exploit the Service except as expressly permitted.</li>
              <li>Reverse engineer, decompile, or attempt to extract source code except where required by law.</li>
              <li>Interfere with Service security, integrity, or performance.</li>
              <li>Use bots, scrapers, or automated extraction tools without permission.</li>
              <li>Upload malicious code, attempt unauthorized access, or violate applicable laws.</li>
            </ul>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>4. AI Outputs and Automation</h2>
            <p>
              The Service may generate AI-powered outputs and may trigger automation based on your configuration and context.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              AI outputs can be inaccurate, incomplete, or non-unique. You are responsible for reviewing outputs and
              automation behavior before relying on them in business, legal, financial, security, or operational decisions.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              You are solely responsible for supervising automations, maintaining backups, and handling the consequences of
              actions initiated through your account.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>5. Your Content</h2>
            <p>
              You are responsible for content, data, prompts, and materials that you submit to or process through the Service
              (Your Content).
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              You retain ownership of Your Content. You grant us a worldwide, non-exclusive, royalty-free license to host,
              store, process, transmit, and display Your Content only as needed to provide, secure, maintain, and improve the
              Service, and as described in our privacy policy.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>6. Security and Backups</h2>
            <p>
              We implement reasonable safeguards, but no system is fully secure or fault tolerant. You are responsible for
              your own backup and recovery processes for critical data.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>7. Intellectual Property</h2>
            <p>
              The Service, including software, branding, design, and associated content, is owned by Tallei or its licensors
              and protected by intellectual property laws. Except for rights expressly granted in these Terms, no rights are
              granted to you.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>8. Third-Party Services</h2>
            <p>
              The Service may integrate or link to third-party products and services. We do not control third-party services
              and are not responsible for their availability, content, or policies. Your use of third-party services is
              governed by their terms.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>9. Billing, Subscriptions, and Fees</h2>
            <p>
              Paid plans are billed under the pricing and payment terms shown at checkout. Unless required by law, fees are
              non-refundable.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Payments are processed by Lemon Squeezy, which acts as Merchant of Record for checkout transactions. By
              purchasing, you also agree to Lemon Squeezy buyer terms and privacy terms for payment processing and tax handling.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Subscription plans may renew automatically unless canceled. You authorize Lemon Squeezy and its payment partners
              to charge your selected payment method for applicable fees and taxes.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Charges may appear on your card statement with a Lemon Squeezy descriptor (for example, `LEMSQZY*` plus store
              identifier).
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              We may change pricing with advance notice. Continued use of a paid plan after the effective date means you accept
              the updated pricing. Refund and chargeback handling may be processed through Lemon Squeezy, including cases where
              Lemon Squeezy issues a refund to prevent chargebacks.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Lemon Squeezy buyer terms:{" "}
              <a
                href="https://www.lemonsqueezy.com/buyer-terms"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline", color: "#1a1816" }}
              >
                lemonsqueezy.com/buyer-terms
              </a>
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Lemon Squeezy privacy policy:{" "}
              <a
                href="https://www.lemonsqueezy.com/privacy"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline", color: "#1a1816" }}
              >
                lemonsqueezy.com/privacy
              </a>
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>10. Service Availability and Changes</h2>
            <p>
              We may modify, suspend, or discontinue all or part of the Service at any time, including for maintenance,
              updates, and operational needs. We are not liable for impacts caused by such changes or interruptions.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>11. Disclaimer of Warranties</h2>
            <p>
              Tallei is provided on an &quot;as is&quot; and &quot;as available&quot; basis without warranties of any kind, express or implied, to
              the fullest extent permitted by law.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>12. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Tallei is not liable for indirect, incidental, special, consequential,
              exemplary, or punitive damages, or for lost profits, revenues, goodwill, or data.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              To the extent liability cannot be disclaimed, our total liability for all claims related to the Service is
              limited to the greater of: (a) the amount you paid us in the six months before the claim, or (b) USD 100.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>13. Dispute Resolution and Arbitration</h2>
            <p>
              Please read this section carefully. It affects your legal rights. Any dispute arising from these Terms or the
              Service will be resolved by binding arbitration on an individual basis, except where prohibited by law or where
              claims may be brought in eligible small claims court.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              You and Tallei waive any right to a jury trial and waive participation in class or representative actions, unless
              a waiver is not enforceable under applicable law.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>14. Termination</h2>
            <p>
              We may suspend or terminate access if these terms are violated or if required to protect the service, users, or
              legal compliance.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              You may stop using the Service at any time. Sections that by nature should survive termination will survive,
              including sections on ownership, disclaimers, liability limits, and dispute resolution.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>15. General Provisions</h2>
            <p>
              We may update these Terms from time to time. If material changes are made, we will provide notice by posting on
              the Site, by email, or by another reasonable method. Continued use of the Service after changes take effect means
              you accept the revised Terms.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              These Terms are the full agreement between you and Tallei regarding the Service and supersede prior agreements on
              the same subject. If any part is unenforceable, the remaining parts remain in effect.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              These Terms are governed by the laws of California, without regard to conflict of laws rules, unless applicable
              law requires otherwise.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>16. Contact</h2>
            <p>
              For questions about these Terms, contact{" "}
              <a href="mailto:hello@tallei.com" style={{ textDecoration: "underline", color: "#1a1816" }}>
                hello@tallei.com
              </a>
              .
            </p>
          </section>

          <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #e5e0d8" }}>
            <Link href="/" style={{ color: "#1a1816", textDecoration: "underline" }}>
              Back to home
            </Link>
          </div>
        </article>
      </div>
    </main>
  );
}
