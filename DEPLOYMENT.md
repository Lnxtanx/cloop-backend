# Backend Deployment Guide for EC2

## Server Information
- **IP Address**: `172.31.35.34` (Private IP)
- **OS**: Ubuntu 24.04.3 LTS
- **Instance Type**: EC2

## Prerequisites Checklist

Before deploying, ensure your EC2 instance has:
- [ ] Node.js 18+ installed
- [ ] PostgreSQL installed and running
- [ ] Git installed
- [ ] PM2 or systemd for process management
- [ ] Security Group allows inbound traffic on port 4000 (or your chosen port)

## Step 1: Connect to EC2 Instance

```bash
ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP
```

## Step 2: Install Required Software

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (v20.x LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Install PM2 globally for process management
sudo npm install -g pm2

# Install Git (if not already installed)
sudo apt install -y git
```

## Step 3: Setup PostgreSQL Database

```bash
# Switch to postgres user
sudo -i -u postgres

# Create database and user
psql
```

In PostgreSQL shell:
```sql
CREATE DATABASE cloop_db;
CREATE USER cloop_user WITH PASSWORD 'your_strong_password';
GRANT ALL PRIVILEGES ON DATABASE cloop_db TO cloop_user;
\q
```

Exit postgres user:
```bash
exit
```

Configure PostgreSQL to accept connections:
```bash
# Edit postgresql.conf
sudo nano /etc/postgresql/16/main/postgresql.conf
# Set: listen_addresses = 'localhost'

# Edit pg_hba.conf
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Add: local   all   cloop_user   md5

# Restart PostgreSQL
sudo systemctl restart postgresql
```

## Step 4: Clone and Setup Backend

```bash
# Create app directory
mkdir -p ~/apps
cd ~/apps

# Clone your repository (replace with your repo URL)
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git cloop-backend
cd cloop-backend/backend

# Install dependencies
npm install

# Create .env file
nano .env
```

Add the following to `.env`:
```env
DATABASE_URL="postgresql://cloop_user:your_strong_password@localhost:5432/cloop_db?schema=public"
PORT=4000
HOST=0.0.0.0
NODE_ENV=production
FRONTEND_URL=http://YOUR_FRONTEND_URL
JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters-long
OPENAI_API_KEY=sk-your-openai-api-key-here
```

## Step 5: Setup Prisma Database

```bash
# Generate Prisma Client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate
```

## Step 6: Start Application with PM2

```bash
# Start the application
pm2 start npm --name "cloop-backend" -- start

# Save PM2 process list
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# Follow the command output instructions

# Check application status
pm2 status

# View logs
pm2 logs cloop-backend
```

## Step 7: Configure EC2 Security Group

In AWS Console:
1. Go to EC2 → Security Groups
2. Select your instance's security group
3. Add Inbound Rules:
   - **Type**: Custom TCP
   - **Port**: 4000
   - **Source**: 
     - `0.0.0.0/0` (for public access) OR
     - Your specific IP/CIDR range (more secure)

## Step 8: Test Deployment

```bash
# From EC2 instance
curl http://localhost:4000/api/signup/options

# From your local machine (replace with your EC2 PUBLIC IP)
curl http://YOUR_PUBLIC_IP:4000/api/signup/options
```

## Step 9: Update Frontend Configuration

In your frontend project (`cloop/src/config/api.ts`):

Option A - Direct IP:
```typescript
return 'http://YOUR_PUBLIC_IP:4000';
```

Option B - Environment Variable:
Create `.env` in frontend root:
```env
EXPO_PUBLIC_API_URL=http://YOUR_PUBLIC_IP:4000
```

## Useful PM2 Commands

```bash
# View application status
pm2 status

# View logs
pm2 logs cloop-backend

# Restart application
pm2 restart cloop-backend

# Stop application
pm2 stop cloop-backend

# Delete application from PM2
pm2 delete cloop-backend

# Monitor resources
pm2 monit
```

## Updating Your Application

```bash
cd ~/apps/cloop-backend/backend

# Pull latest changes
git pull origin main

# Install new dependencies (if any)
npm install

# Run migrations (if any)
npm run prisma:migrate

# Restart application
pm2 restart cloop-backend
```

## Setting Up HTTPS (Optional but Recommended)

### Option 1: Using Nginx as Reverse Proxy with Let's Encrypt

```bash
# Install Nginx
sudo apt install -y nginx

# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Configure Nginx
sudo nano /etc/nginx/sites-available/cloop
```

Add:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/cloop /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# Get SSL certificate
sudo certbot --nginx -d your-domain.com
```

## Troubleshooting

### Application won't start
```bash
# Check logs
pm2 logs cloop-backend --lines 100

# Check if port is in use
sudo lsof -i :4000

# Check database connection
psql -U cloop_user -d cloop_db -h localhost
```

### Database connection errors
```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Check database exists
sudo -u postgres psql -l

# Test connection
psql "postgresql://cloop_user:password@localhost:5432/cloop_db"
```

### Can't access from outside
- Verify EC2 Security Group inbound rules
- Check if application is listening on 0.0.0.0
- Verify firewall settings: `sudo ufw status`

### CORS errors
- Update `FRONTEND_URL` in `.env`
- Check CORS configuration in `index.js`
- Restart application: `pm2 restart cloop-backend`

## Monitoring and Maintenance

```bash
# Check disk space
df -h

# Check memory usage
free -m

# Check application performance
pm2 monit

# View system logs
journalctl -u postgresql -f
```

## Backup Database

```bash
# Create backup
pg_dump -U cloop_user -d cloop_db > backup_$(date +%Y%m%d).sql

# Restore backup
psql -U cloop_user -d cloop_db < backup_20241115.sql
```

## Security Best Practices

1. ✅ Keep system updated: `sudo apt update && sudo apt upgrade`
2. ✅ Use strong passwords for database
3. ✅ Don't commit `.env` file to Git
4. ✅ Restrict Security Group to specific IPs when possible
5. ✅ Use HTTPS in production (setup Nginx + Let's Encrypt)
6. ✅ Regularly backup database
7. ✅ Monitor logs for suspicious activity
8. ✅ Keep dependencies updated: `npm audit fix`

## Quick Deployment Script

Create `deploy.sh`:
```bash
#!/bin/bash
cd ~/apps/cloop-backend/backend
git pull origin main
npm install
npm run prisma:generate
npm run prisma:migrate
pm2 restart cloop-backend
echo "Deployment complete!"
```

Make executable: `chmod +x deploy.sh`

---

## Need Help?

- Check PM2 logs: `pm2 logs cloop-backend`
- Check system logs: `sudo journalctl -xe`
- PostgreSQL logs: `sudo tail -f /var/log/postgresql/postgresql-16-main.log`
