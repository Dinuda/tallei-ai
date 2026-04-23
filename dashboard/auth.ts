import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

type UserPlan = "free" | "pro" | "power";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      image: string;
      plan?: UserPlan;
    };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost:
    process.env.AUTH_TRUST_HOST === "true" || process.env.NODE_ENV === "production",

  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      checks: ["none"],
    }),
  ],

  callbacks: {
    async signIn({ user, profile }) {
      // Sync the Google user into our Postgres DB and get the internal userId.
      const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3000";
      const secret = process.env.INTERNAL_API_SECRET;
      if (!secret) {
        console.error("[auth] INTERNAL_API_SECRET is not set");
        return false;
      }

      try {
        const res = await fetch(`${backendUrl}/api/auth/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": secret,
          },
          body: JSON.stringify({
            sub: (profile as { sub?: string })?.sub ?? user.id,
            email: user.email,
          }),
        });

        if (!res.ok) {
          console.error("[auth] User sync failed:", await res.text());
          return false;
        }

        const { userId, plan } = (await res.json()) as { userId: string; plan?: UserPlan };
        // Attach our internal userId to the user object so the jwt callback
        // can pick it up.
        (user as { backendId?: string; backendPlan?: UserPlan }).backendId = userId;
        (user as { backendId?: string; backendPlan?: UserPlan }).backendPlan = plan ?? "free";
        return true;
      } catch (err) {
        console.error("[auth] User sync error:", err);
        return false;
      }
    },

    async jwt({ token, user }) {
      // On first sign-in, user is populated — persist our backendId.
      if (user) {
        token.backendId = (user as { backendId?: string }).backendId;
        token.backendPlan = (user as { backendPlan?: UserPlan }).backendPlan ?? "free";
      }
      return token;
    },

    async session({ session, token }) {
      // Expose our internal userId as session.user.id
      if (token.backendId) {
        session.user.id = token.backendId as string;
      }
      session.user.plan = token.backendPlan as UserPlan | undefined;
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/auth/error",
  },
});
