import { supabase } from '@/integrations/supabase/client';

export const deploymentService = {
  /**
   * Export project for production deployment
   */
  async exportProject(projectId: string, format: 'html' | 'production' = 'production') {
    const { data, error } = await supabase.functions.invoke('export-project', {
      body: {
        project_id: projectId,
        format: format
      }
    });

    if (error) throw error;
    return data;
  },

  /**
   * Download production bundle as files
   */
  async downloadProductionBundle(projectId: string) {
    const bundle = await this.exportProject(projectId, 'production');
    
    // Create downloadable ZIP (browser-side)
    return this.createZipDownload(bundle.files);
  },

  /**
   * Deploy to production server via FTP/SFTP
   */
  async deployToServer(projectId: string, serverConfig: {
    host: string;
    username: string;
    password: string;
    path: string;
  }) {
    const bundle = await this.exportProject(projectId, 'production');
    
    // Call deployment edge function
    const { data, error } = await supabase.functions.invoke('deploy-to-server', {
      body: {
        files: bundle.files,
        server: serverConfig
      }
    });

    if (error) throw error;
    return data;
  },

  /**
   * Create ZIP file for download (client-side)
   */
  async createZipDownload(files: Array<{ path: string; content: string }>) {
    // Using JSZip library
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    files.forEach(file => {
      zip.file(file.path, file.content);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    
    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'production-bundle.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Publish to custom domain (your platform's hosting)
   */
  async publishToCustomDomain(projectId: string, domain: string) {
    const { data, error } = await supabase.functions.invoke('publish-site', {
      body: {
        project_id: projectId,
        domain: domain
      }
    });

    if (error) throw error;
    
    // Update published_versions table
    await supabase.from('published_versions').insert({
      project_id: projectId,
      deployment_url: `https://${domain}`,
      status: 'active',
      deployed_by: (await supabase.auth.getUser()).data.user?.id
    });

    return data;
  }
};
