import { Shield } from "lucide-react";

export default function PrivacyPolicy() {
    return (
        <div className="min-h-screen bg-[#101622] text-white">

            {/* Hero */}
            <section className="relative pt-28 pb-16 px-6 overflow-hidden">
                <div className="absolute inset-0 -z-10 pointer-events-none">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[50%] h-[40%] rounded-full bg-blue-500/8 blur-[120px]" />
                </div>
                <div className="max-w-3xl mx-auto text-center">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 mb-6">
                        <Shield className="w-7 h-7 text-blue-400" />
                    </div>
                    <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                        Privacy Policy
                    </h1>
                    <p className="text-lg text-slate-400">
                        Last updated: January 9, 2026
                    </p>
                </div>
            </section>

            <section className="pb-24 px-6">
                <div className="max-w-3xl mx-auto space-y-8">
                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Introduction</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    At eCOMGear, we take your privacy seriously. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our AI-powered application builder platform.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Information We Collect</h2>
                                <p className="text-slate-400 leading-relaxed mb-4">
                                    We collect information that you provide directly to us, including:
                                </p>
                                <ul className="list-disc list-inside text-slate-400 space-y-2 ml-4">
                                    <li>Account information (name, email address, password)</li>
                                    <li>Project data and generated code</li>
                                    <li>Usage data and analytics</li>
                                    <li>Payment information (processed securely through third-party providers)</li>
                                    <li>Communications with our support team</li>
                                </ul>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">How We Use Your Information</h2>
                                <p className="text-slate-400 leading-relaxed mb-4">
                                    We use the information we collect to:
                                </p>
                                <ul className="list-disc list-inside text-slate-400 space-y-2 ml-4">
                                    <li>Provide, maintain, and improve our services</li>
                                    <li>Process your transactions and send related information</li>
                                    <li>Send you technical notices, updates, and support messages</li>
                                    <li>Respond to your comments and questions</li>
                                    <li>Monitor and analyze trends, usage, and activities</li>
                                    <li>Detect, prevent, and address technical issues and fraudulent activity</li>
                                </ul>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Data Security</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    We implement appropriate technical and organizational measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction. However, no method of transmission over the Internet is 100% secure.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Your Rights</h2>
                                <p className="text-slate-400 leading-relaxed mb-4">
                                    You have the right to:
                                </p>
                                <ul className="list-disc list-inside text-slate-400 space-y-2 ml-4">
                                    <li>Access and receive a copy of your personal data</li>
                                    <li>Rectify inaccurate personal data</li>
                                    <li>Request deletion of your personal data</li>
                                    <li>Object to processing of your personal data</li>
                                    <li>Request restriction of processing your personal data</li>
                                    <li>Data portability</li>
                                </ul>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Contact Us</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    If you have any questions about this Privacy Policy, please contact us at{" "}
                                    <a href="mailto:info@ecomgear.dev" className="text-blue-400 hover:text-blue-300 transition-colors">
                                        info@ecomgear.dev
                                    </a>
                                </p>
                            </section>
                </div>
            </section>
        </div>
    );
}
