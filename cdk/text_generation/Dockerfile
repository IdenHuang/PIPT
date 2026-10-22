# Stage 1: Builder — compile C extensions
FROM public.ecr.aws/lambda/python:3.12 AS builder

# Install system build dependencies
RUN dnf -y install postgresql-devel gcc gcc-c++ libpq make

# Copy locked requirements and install to a clean target directory
COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip install -r requirements.txt --no-cache-dir --target /install

# Stage 2: Runtime — slim image
FROM public.ecr.aws/lambda/python:3.12

ENV PYTHONUNBUFFERED=1

# Apply OS security updates the base image tag may not include yet, then
# install only runtime shared libraries. AL2023 pins dnf to the image's release,
# so --releasever=latest is needed to see newer patched packages.
# https://docs.aws.amazon.com/linux/al2023/ug/deterministic-upgrades.html
RUN dnf -y upgrade --releasever=latest \
    && dnf -y install --releasever=latest libpq \
    && dnf clean all

# Copy compiled packages from builder
COPY --from=builder /install ${LAMBDA_TASK_ROOT}

# Copy application source
COPY src/ ${LAMBDA_TASK_ROOT}

# Set the CMD to your handler
CMD ["main.handler"]
