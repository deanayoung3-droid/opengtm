FROM postgres:16-alpine
RUN apk add --no-cache rclone tzdata
COPY backup.sh restore-check.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore-check.sh
ENV RCLONE_CONFIG=/config/rclone/rclone.conf
CMD ["/usr/local/bin/backup.sh", "loop"]
