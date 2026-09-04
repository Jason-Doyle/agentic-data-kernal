{{- define "agentic-data-kernel.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "agentic-data-kernel.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "agentic-data-kernel.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "agentic-data-kernel.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentic-data-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "agentic-data-kernel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentic-data-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "agentic-data-kernel.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agentic-data-kernel.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "agentic-data-kernel.pvcName" -}}
{{- default (printf "%s-artifacts" (include "agentic-data-kernel.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{- define "agentic-data-kernel.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (required "image.tag is required when image.digest is empty" .Values.image.tag) }}
{{- end }}
{{- end }}

{{- define "agentic-data-kernel.configChecksum" -}}
{{- include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- end }}
