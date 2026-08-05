import { FileText } from "lucide-react";

export default function TermsOfService() {
    return (
        <div className="min-h-screen bg-[#101622] text-white">

            {/* Hero */}
            <section className="relative pt-28 pb-16 px-6 overflow-hidden">
                <div className="max-w-3xl mx-auto text-center">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 mb-6">
                        <FileText className="w-7 h-7 text-primary" />
                    </div>
                    <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
                        Terms of Service
                    </h1>
                    <p className="text-lg text-slate-400">
                        Last updated: January 9, 2026
                    </p>
                </div>
            </section>

            <section className="pb-24 px-6">
                <div className="max-w-3xl mx-auto space-y-8">
                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Agreement to Terms</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    By accessing or using eCOMGear, you agree to be bound by these Terms of Service and all applicable laws and regulations. If you do not agree with any of these terms, you are prohibited from using or accessing this service.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Use License</h2>
                                <p className="text-slate-400 leading-relaxed mb-4">
                                    Permission is granted to use eCOMGear for personal and commercial purposes under the following conditions:
                                </p>
                                <ul className="list-disc list-inside text-slate-400 space-y-2 ml-4">
                                    <li>You must maintain an active subscription for continued access</li>
                                    <li>You own all code and projects generated through our platform</li>
                                    <li>You may not attempt to reverse engineer or copy our AI models</li>
                                    <li>You must not use the service for illegal or unauthorized purposes</li>
                                </ul>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">User Accounts</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    You are responsible for maintaining the confidentiality of your account and password. You agree to accept responsibility for all activities that occur under your account. We reserve the right to refuse service, terminate accounts, or remove content at our sole discretion.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Intellectual Property</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    All code generated through eCOMGear belongs to you. However, the eCOMGear platform, including its AI models, design, and functionality, remains the intellectual property of eCOMGear and is protected by copyright and other intellectual property laws.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Limitation of Liability</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    eCOMGear shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of or inability to use the service. We provide the service "as is" without warranties of any kind.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Modifications</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    We reserve the right to modify these terms at any time. We will notify users of any material changes via email or through the platform. Continued use of the service after such modifications constitutes acceptance of the updated terms.
                                </p>
                            </section>

                            <section>
                                <h2 className="text-2xl font-bold text-white mb-4">Contact Information</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    For questions about these Terms of Service, please contact us at{" "}
                                    <a href="mailto:info@ecomgear.dev" className="text-primary hover:text-primary/80 transition-colors">
                                        info@ecomgear.dev
                                    </a>
                                </p>
                            </section>
                </div>
            </section>
        </div>
    );
}
