// AWS Lambda function to generate presigned URLs for S3 uploads
// Save this to a Lambda function and configure with an API Gateway

const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  region: 'us-east-1' // Change to your region
});

exports.handler = async (event) => {
  try {
    // Parse request body
    const body = JSON.parse(event.body);
    const { filename, contentType, sourceUrl, pageTitle } = body;
    
    if (!filename || !contentType) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }
    
    // Configure S3 upload parameters
    const bucketName = process.env.BUCKET_NAME; // Set this as an environment variable
    const key = filename;
    
    // Generate presigned URL with a 5-minute expiration
    const presignedUrl = await s3.getSignedUrlPromise('putObject', {
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
      Expires: 300, // URL expires in 5 minutes
      Metadata: {
        'source-url': sourceUrl || '',
        'page-title': pageTitle || ''
      }
    });
    
    // Return the presigned URL to the client
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Adjust this for production
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
      },
      body: JSON.stringify({
        url: presignedUrl,
        key: key,
        bucket: bucketName
      })
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error generating presigned URL' })
    };
  }
};

// Required IAM permissions for this Lambda:
/*
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/*"
    }
  ]
}
*/
