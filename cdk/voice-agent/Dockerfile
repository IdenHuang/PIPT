# Amazon Linux 2023 instead of python:3.12-slim (Debian 13): the Debian image
# carries HIGH zlib/glibc CVEs with no trixie fix (CVE-2026-85091 unfixed
# upstream; CVE-2026-5435 and CVE-2026-19499 marked no-dsa). AL2023 is not
# affected or rates them below HIGH, and gets patches through ALAS.
# The REGISTRY build arg passed by CodeBuild is accepted but unused here.
ARG REGISTRY=""
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Apply OS security updates the base tag may not include yet, and install
# Python 3.12. AL2023 pins dnf to the image's release, so --releasever=latest
# is needed to see newer patched packages.
# https://docs.aws.amazon.com/linux/al2023/ug/deterministic-upgrades.html
RUN dnf -y upgrade --releasever=latest \
    && dnf -y install --releasever=latest python3.12 python3.12-pip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

WORKDIR /app

COPY requirements.txt .
RUN python3.12 -m pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1

# AgentCore expects /ping, /invocations, and /ws on port 8080
EXPOSE 8080

CMD ["python3.12", "bot.py"]
