FROM nginx:alpine

# Copy the website files to nginx html directory
COPY . /usr/share/nginx/html/
COPY nginx-gzip.conf /etc/nginx/conf.d/gzip.conf

# Remove unnecessary files
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/docker-compose.yml /usr/share/nginx/html/nginx-gzip.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
