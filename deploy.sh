#!/bin/bash

# Quick Deploy Script for Cloop Backend on EC2
# Run this script on your EC2 instance after initial setup

echo "🚀 Starting Cloop Backend Deployment..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
APP_DIR=~/apps/cloop-backend/backend
APP_NAME=cloop-backend

# Check if directory exists
if [ ! -d "$APP_DIR" ]; then
    echo -e "${RED}❌ Directory $APP_DIR does not exist!${NC}"
    echo "Please clone your repository first:"
    echo "  mkdir -p ~/apps"
    echo "  cd ~/apps"
    echo "  git clone YOUR_REPO_URL cloop-backend"
    exit 1
fi

cd $APP_DIR

echo -e "${YELLOW}📥 Pulling latest changes...${NC}"
git pull origin main

echo -e "${YELLOW}📦 Installing dependencies...${NC}"
npm install

echo -e "${YELLOW}🔧 Generating Prisma Client...${NC}"
npm run prisma:generate

echo -e "${YELLOW}🗄️  Running database migrations...${NC}"
npm run prisma:migrate

# Check if PM2 process exists
if pm2 describe $APP_NAME > /dev/null 2>&1; then
    echo -e "${YELLOW}🔄 Restarting application...${NC}"
    pm2 restart $APP_NAME
else
    echo -e "${YELLOW}🚀 Starting application for the first time...${NC}"
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save
fi

echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "📊 Application Status:"
pm2 status

echo ""
echo "📝 View logs with: pm2 logs $APP_NAME"
echo "🔍 Monitor with: pm2 monit"
