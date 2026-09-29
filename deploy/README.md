# Nginx deployment

This site is served from `/var/www/pre_planting` at `http://ftbc-public1.ffpri.go.jp/pre_planting/`.

From the repository directory, install Nginx and publish only the required static files:

```sh
sudo apt update
sudo apt install nginx
sudo install -d -o root -g www-data -m 0755 /var/www/pre_planting
sudo install -o root -g www-data -m 0644 index.html app.js style.css theme.js /var/www/pre_planting/
sudo install -o root -g root -m 0644 deploy/nginx-pre_planting.conf /etc/nginx/sites-available/pre_planting
sudo ln -sfn /etc/nginx/sites-available/pre_planting /etc/nginx/sites-enabled/pre_planting
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

If UFW is active, allow HTTP with `sudo ufw allow 'Nginx HTTP'`. Also ensure the server/network firewall permits inbound TCP port 80.

The Nginx policy serves only GET and HEAD requests, disables directory listings, denies dotfiles, and sets a restrictive Content Security Policy for the app's required map tiles, CDN libraries, and font host. Do not copy `.git` into the web root.

This HTTP endpoint is not encrypted. For production use, configure HTTPS with a certificate (for example, Let's Encrypt/Certbot) and redirect HTTP to HTTPS before enabling HSTS. Do not send sensitive data over the HTTP URL.