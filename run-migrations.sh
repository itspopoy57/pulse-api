#!/bin/bash
# Run Prisma migrations on production database

echo "🔄 Running Prisma migrations..."
npx prisma migrate deploy

echo "✅ Generating Prisma client..."
npx prisma generate

echo "🎉 Done! Migrations applied successfully."
