// Cloudflare Worker for R2 uploads
// Deploy this to your Cloudflare Workers environment

// You'll need these bindings:
// - R2_BUCKET: R2 bucket binding

export default {
  async fetch(request, env) {
    try {
      // Handle OPTIONS for CORS preflight
      if (request.method === 'OPTIONS') {
        return handleCORS();
      }
      
      // Only allow POST requests
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      
      // Check authorization if needed
      const authHeader = request.headers.get('Authorization');
      if (!validateAuth(authHeader, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      
      // Handle multipart form data
      const formData = await request.formData();
      const file = formData.get('file');
      
      if (!file) {
        return new Response('No file provided', { status: 400 });
      }
      
      // Extract metadata
      const sourceUrl = formData.get('sourceUrl') || '';
      const pageTitle = formData.get('pageTitle') || '';
      const timestamp = formData.get('timestamp') || new Date().toISOString();
      
      // Generate a filename if not provided
      let filename = file.name || `image_${Date.now()}.jpg`;
      
      // Sanitize filename (remove unsafe characters)
      filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
                         .substring(0, 100); // Limit length
      
      // Set up custom metadata
      const customMetadata = {
        sourceUrl,
        pageTitle,
        timestamp,
        uploadedBy: 'Page Image Saver Extension'
      };
      
      // Upload to R2
      await env.R2_BUCKET.put(filename, file, {
        httpMetadata: {
          contentType: file.type,
        },
        customMetadata
      });
      
      // Generate a public URL for the uploaded file
      // Note: You'll need to configure R2 public access or create a custom
      // solution to serve these files
      const publicUrl = `https://your-public-bucket-url.com/${filename}`;
      
      // Return success response with CORS headers
      return corsResponse({
        success: true,
        filename,
        url: publicUrl,
        size: file.size,
        type: file.type
      }, 200);
      
    } catch (error) {
      console.error('Error processing upload:', error);
      return corsResponse({
        success: false,
        error: 'Failed to process upload'
      }, 500);
    }
  }
};

// Helper to validate authorization
function validateAuth(authHeader, env) {
  // Implement your auth validation logic here
  // For example, check against an API token
  // const expectedToken = env.API_TOKEN;
  // return authHeader === `Bearer ${expectedToken}`;
  
  // For demonstration, we're not requiring auth
  return true;
}

// Helper to add CORS headers to responses
function corsResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Restrict this in production
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

// Helper for CORS preflight requests
function handleCORS() {
  return new Response(null, {
    status: 204, // No content
    headers: {
      'Access-Control-Allow-Origin': '*', // Restrict this in production
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400' // 24 hours
    }
  });
}
