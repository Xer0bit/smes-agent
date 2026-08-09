#!/bin/bash

# start-supabase.sh
# Script to prepare the development environment and start Supabase using .env variables

echo "🚀 Initializing Development Environment..."

# check if .env exists
if [ -f .env ]; then
  echo "📄 Loading environment variables from .env..."
  # Export variables from .env, ignoring comments and empty lines
  export $(grep -v '^#' .env | xargs)
  echo "✅ Environment variables loaded."
else
  echo "⚠️  .env file not found! Using default configuration if available."
fi

# Print key configuration (masked for security if needed, but locally okay)
echo "----------------------------------------"
echo "Supabase URL: ${SUPABASE_URL:-'Not set (will allow supabase start to determine)'}"
echo "----------------------------------------"

# Check if Docker is running (Supabase needs Docker)
if ! docker info > /dev/null 2>&1; then
  echo "❌ Error: Docker is not running. Please start Docker and try again."
  exit 1
fi

echo "🐳 Checking Supabase status..."
if npx supabase status > /dev/null 2>&1; then
  echo "✅ Supabase is already running."
  npx supabase status
else
  echo "⚠️  Supabase is not clean. Resetting services..."
  npx supabase stop > /dev/null 2>&1
  echo "🐳 Starting Supabase services..."
  npx supabase start
fi

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Supabase is ready!"
  echo "----------------------------------------"
  echo "API URL:      ${SUPABASE_URL}"
  # Note: These ports are defaults; if changed in config, supabase status output above is the source of truth
  echo "Studio URL:   http://127.0.0.1:54323"
  echo "Inbucket URL: http://127.0.0.1:54324"
  echo "----------------------------------------"
else
  echo "❌ Failed to start Supabase."
  exit 1
fi
