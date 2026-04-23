import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for using Tallei.",
  alternates: {
    canonical: "https://tallei.com/privacy",
  },
};

const sectionStyle = { marginBottom: "1.5rem" } as const;
const sectionTitleStyle = { fontSize: "1.25rem", marginBottom: "0.5rem", color: "#1a1816" } as const;
const listStyle = { paddingLeft: "1.25rem", marginTop: "0.5rem", color: "#4c4643" } as const;

export default function PrivacyPage() {
  return (
    <main className="main-content" style={{ background: "#fdfbf7", paddingBottom: "5rem" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 2rem" }}>
        <article
          className="solid-card"
          style={{ padding: "2.25rem", borderColor: "#1a1816", boxShadow: "6px 6px 0 rgba(0, 0, 0, 0.08)" }}
        >
          <h1 style={{ fontSize: "2.2rem", marginBottom: "0.75rem", color: "#1a1816" }}>Privacy Policy</h1>
          <p style={{ marginBottom: "2rem", color: "#4c4643", fontSize: "0.95rem" }}>
            Last updated: April 19, 2026
          </p>

          <p style={{ marginBottom: "1rem" }}>
            At Tallei (&quot;Tallei,&quot; &quot;we,&quot; &quot;our,&quot; or &quot;us&quot;), we take privacy seriously. This Privacy Policy explains how we
            collect, use, disclose, and protect your information when you use our website, software, APIs, and related
            services (collectively, the Service).
          </p>
          <p style={{ marginBottom: "2rem" }}>
            Your use of the Service is also subject to our Terms of Service. If you continue using the Service after this
            policy is updated, you accept the revised policy.
          </p>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>1. What This Policy Covers</h2>
            <p>This policy covers Personal Data and Operational Data we process when you use the Service.</p>
            <ul style={listStyle}>
              <li>Personal Data: Information that identifies you, such as name, email, and billing details.</li>
              <li>
                Operational Data: Technical and product-usage data, such as logs, diagnostics, performance metrics, and event
                telemetry.
              </li>
            </ul>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>2. Data We Collect</h2>
            <p>Depending on how you use the Service, we may collect:</p>
            <ul style={listStyle}>
              <li>Account data: Name, email, password hash, account identifiers.</li>
              <li>Billing data: Subscription plan, transaction metadata, invoice identifiers, tax region metadata.</li>
              <li>Device and network data: IP address, browser, OS, and device metadata.</li>
              <li>Usage and diagnostics: Feature usage, logs, crash reports, and performance data.</li>
              <li>Support data: Information you provide in support messages or feedback.</li>
              <li>Connected service metadata: Integration status and required technical identifiers.</li>
            </ul>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>3. Sources of Data</h2>
            <ul style={listStyle}>
              <li>Directly from you (account signup, support, forms, and settings).</li>
              <li>Automatically from your use of the Service.</li>
              <li>From connected third-party services that you authorize.</li>
              <li>From billing providers for payment and subscription lifecycle events.</li>
            </ul>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>4. How We Use Data</h2>
            <ul style={listStyle}>
              <li>Provide, maintain, and secure the Service.</li>
              <li>Authenticate users and prevent fraud or abuse.</li>
              <li>Process billing, subscriptions, invoices, and payment-related events.</li>
              <li>Diagnose bugs and improve reliability and product performance.</li>
              <li>Provide support and communicate service updates.</li>
              <li>Comply with legal obligations and enforce our Terms.</li>
            </ul>
            <p style={{ marginTop: "0.5rem" }}>
              We do not sell Personal Data for third-party advertising. We do not use your private memory content to train
              foundation models.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>5. Lemon Squeezy and Payments</h2>
            <p>
              We use Lemon Squeezy to process payments and subscription billing. Lemon Squeezy acts as Merchant of Record for
              checkout transactions.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Payment details are processed by Lemon Squeezy and its payment partners. We receive subscription and transaction
              metadata needed to manage your account and entitlements.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Lemon Squeezy may collect and process taxes based on transaction jurisdiction. Their policies apply to payment
              processing:
              {" "}
              <a
                href="https://www.lemonsqueezy.com/privacy"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline", color: "#1a1816" }}
              >
                lemonsqueezy.com/privacy
              </a>
              {" "}and{" "}
              <a
                href="https://www.lemonsqueezy.com/buyer-terms"
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline", color: "#1a1816" }}
              >
                lemonsqueezy.com/buyer-terms
              </a>
              .
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>6. How We Share Data</h2>
            <p>We may share data with:</p>
            <ul style={listStyle}>
              <li>Service providers that host, secure, operate, and support the Service.</li>
              <li>Payment processors and billing providers for subscription and transaction workflows.</li>
              <li>Integration partners you explicitly connect.</li>
              <li>Professional advisors and legal authorities where required by law.</li>
              <li>Successors in connection with merger, acquisition, or sale of assets.</li>
            </ul>
            <p style={{ marginTop: "0.5rem" }}>
              We may also share aggregated or de-identified information that cannot reasonably identify an individual.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>7. Cookies and Similar Technologies</h2>
            <p>We use cookies and similar technologies to keep sessions secure, remember settings, and analyze usage.</p>
            <p style={{ marginTop: "0.5rem" }}>
              You can manage cookies in your browser settings. Some features may not function correctly if cookies are blocked.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>8. Security</h2>
            <p>
              We use reasonable technical and organizational safeguards, including encryption in transit, access controls, and
              security monitoring. No system can be guaranteed completely secure.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>9. Data Retention</h2>
            <p>
              We retain data for as long as needed to provide the Service, comply with legal obligations, resolve disputes, and
              enforce agreements.
            </p>
            <p style={{ marginTop: "0.5rem" }}>
              Retention periods vary by data type, account status, contractual requirements, and legal obligations.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>10. Your Rights and Choices</h2>
            <p>Depending on your location, you may have rights to access, correct, delete, or export your data.</p>
            <p style={{ marginTop: "0.5rem" }}>
              You may also object to or restrict certain processing, and you may request account deletion. We may need to verify
              your identity and retain certain records where required by law.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>11. Cross-Border Data Processing</h2>
            <p>
              We and our providers may process data in the United States and other countries. These locations may have
              different data protection laws from your country.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>12. Children&apos;s Privacy</h2>
            <p>
              The Service is not directed to children under 18, and we do not knowingly collect personal information from
              children under 18.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>13. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. If material changes are made, we will provide notice by
              posting on the Site, by email, or by another reasonable method.
            </p>
          </section>

          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>14. Contact</h2>
            <p>
              For privacy questions or requests, contact{" "}
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
