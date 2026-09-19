# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY app.js .
COPY credentials.json .

# Expose port 8080 (Cloud Run requirement)
EXPOSE 8080

# Start the application
CMD ["node", "app.js"]
