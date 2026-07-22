import type { Metadata } from "next";
import { headers } from "next/headers";
import Nav from "@/components/Nav";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Usage Monitor",
  description: "Monitor usage and balance across multiple API providers",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware sets x-nonce; attach it to inline boot scripts so CSP allows them.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var d = localStorage.getItem('display-density') || 'compact';
                  document.documentElement.classList.add('density-' + d);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 antialiased min-h-screen">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          nonce={nonce}
        >
          <Nav />
          <main className="max-w-7xl mx-auto px-3 py-5 sm:px-6 sm:py-8 lg:px-8">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
