import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams, Link } from 'react-router-dom';
import { 
  getBlurInterpretation, 
  getBrightnessInterpretation 
} from '../utils/analysisHelpers';

const JobResults: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null); // results.results from API
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchJobData = async () => {
      try {
        const [jobRes, resultsRes] = await Promise.all([
          axios.get(`/api/v1/jobs/${id}/status`),
          axios.get(`/api/v1/jobs/${id}/results`)
        ]);
        setJob(jobRes.data.job);
        setAnalysis(resultsRes.data.results);
      } catch (err: any) {
        console.error(err);
        if (err.response?.status === 409) {
          // Job still processing, keep loading state or show partial
          setError('Analysis in progress. Please refresh in a few seconds.');
        } else {
          setError(err.response?.data?.message || 'Failed to fetch job data');
        }
      } finally {
        setLoading(false);
      }
    };
    if (id) fetchJobData();
  }, [id]);

  if (loading) {
    return (
      <div className="p-xl text-center space-y-md">
        <div className="animate-spin text-secondary inline-block">
          <span className="material-symbols-outlined text-4xl">sync</span>
        </div>
        <p className="font-headline-md text-primary">Orchestrating CV Pipeline...</p>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="p-xl text-center">
        <p className="font-headline-md text-error mb-md">{error || 'Job not found'}</p>
        <Link to="/jobs" className="text-primary hover:underline">Return to list</Link>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'failed': return 'bg-red-100 text-red-700 border-red-200';
      case 'processing': return 'bg-amber-100 text-amber-700 border-amber-200';
      default: return 'bg-surface-container text-outline border-outline-variant';
    }
  };

  const getQualityTier = (score: number) => {
    if (score >= 90) return { text: 'Premium Fidelity', desc: 'Optimal production standard' };
    if (score >= 75) return { text: 'High Quality', desc: 'Reliable for automated processing' };
    if (score >= 50) return { text: 'Acceptable', desc: 'May contain minor fidelity artifacts' };
    return { text: 'Low Fidelity', desc: 'Manual review strongly recommended' };
  };

  const displayScore = Math.round((job.qualityScore || 0) * 100);
  const tier = getQualityTier(displayScore);

  // Perceptual interpretations with safe mapping
  const blurInfo = getBlurInterpretation(analysis?.blur);
  const brightnessInfo = getBrightnessInterpretation(analysis?.brightness);

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header Section */}
      <section className="mb-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-lg">
        <div className="space-y-base">
          <div className="flex items-center gap-sm">
            <span className="px-sm py-xs bg-secondary-fixed text-on-secondary-fixed-variant rounded font-code-sm text-code-sm">
              JOB-{id?.substring(0, 8).toUpperCase()}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${getStatusColor(job.status)}`}>
              {job.status}
            </span>
          </div>
          <h1 className="font-headline-xl text-headline-xl text-primary">{job.originalFilename || 'Processing Results'}</h1>
          <div className="flex items-center gap-md text-outline font-body-md">
            <div className="flex items-center gap-xs">
              <span className="material-symbols-outlined text-[18px]">calendar_today</span>
              <span>{new Date(job.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex items-center gap-xs">
              <span className="material-symbols-outlined text-[18px]">tag</span>
              <span>UUID: {job.id}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-xl bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-sm">
          <div className="relative w-20 h-20">
            <svg className="w-full h-full transform -rotate-90">
              <circle className="text-surface-container-highest" cx="40" cy="40" fill="transparent" r="36" stroke="currentColor" strokeWidth="8"></circle>
              <circle 
                className="text-secondary transition-all duration-1000 ease-out" 
                cx="40" cy="40" fill="transparent" r="36" stroke="currentColor" 
                strokeDasharray="226.2" 
                strokeDashoffset={226.2 - ((displayScore || 0) / 100) * 226.2} 
                strokeWidth="8"
              ></circle>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center font-headline-md text-primary">
              {job.status === 'completed' ? displayScore : '—'}
            </div>
          </div>
          <div>
            <p className="font-label-md text-outline uppercase tracking-wider">Quality Score</p>
            <p className="font-headline-md text-primary">{job.status === 'completed' ? tier.text : 'Analyzing...'}</p>
            <p className="text-body-md text-on-surface-variant">{job.status === 'completed' ? tier.desc : 'Final score pending pipeline completion'}</p>
          </div>
        </div>
      </section>

      {/* Result Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
        
        {/* Sharpness Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className={`material-symbols-outlined ${blurInfo.color}`}>
                {blurInfo.icon}
              </span>
              <h3 className="font-headline-md text-headline-md">Sharpness</h3>
            </div>
            <div className="flex flex-col items-end">
              <span className="font-code-sm text-[10px] text-outline uppercase">Confidence</span>
              <span className="font-headline-sm text-primary">
                {analysis?.blur?.confidence !== undefined ? `${Math.round(analysis.blur.confidence * 100)}%` : '—'}
              </span>
            </div>
          </div>
          
          <div className="flex-1 space-y-md">
            <div>
              <p className={`font-headline-sm ${blurInfo.color}`}>
                {blurInfo.label}
              </p>
              <p className="text-body-md text-on-surface-variant mt-1">
                {blurInfo.desc}
              </p>
            </div>
            
            {analysis?.blur?.details && (
              <div className="p-md bg-surface-container-low rounded-lg space-y-xs border border-outline-variant">
                <p className="text-[10px] font-bold text-outline uppercase tracking-widest mb-1">Diagnostics</p>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Edge Energy</span>
                  <span className="text-primary font-code-sm">{analysis.blur.details.laplacianVariance?.toFixed(1) ?? '—'}</span>
                </div>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Motion Coherence</span>
                  <span className={`font-code-sm ${analysis.blur.details.directionalCoherence > 0.15 ? 'text-error' : 'text-primary'}`}>
                    {analysis.blur.details.directionalCoherence?.toFixed(3) ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Spatial Dist.</span>
                  <span className="text-primary font-code-sm">{analysis.blur.details.lowerQuartileBlockSharpness?.toFixed(1) ?? '—'}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Exposure Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className={`material-symbols-outlined ${brightnessInfo.color}`}>
                {brightnessInfo.icon}
              </span>
              <h3 className="font-headline-md text-headline-md">Exposure</h3>
            </div>
            <div className="flex flex-col items-end">
              <span className="font-code-sm text-[10px] text-outline uppercase">Contrast</span>
              <span className="font-headline-sm text-primary">
                {analysis?.brightness?.details?.rmsContrast !== undefined ? analysis.brightness.details.rmsContrast.toFixed(1) : '—'}
              </span>
            </div>
          </div>
          
          <div className="flex-1 space-y-md">
            <div>
              <p className={`font-headline-sm ${brightnessInfo.color}`}>
                {brightnessInfo.label}
              </p>
              <p className="text-body-md text-on-surface-variant mt-1">
                {brightnessInfo.desc}
              </p>
            </div>

            {analysis?.brightness?.details && (
              <div className="p-md bg-surface-container-low rounded-lg space-y-xs border border-outline-variant">
                <p className="text-[10px] font-bold text-outline uppercase tracking-widest mb-1">Light Map</p>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Median Luminance</span>
                  <span className="text-primary font-code-sm">{analysis.brightness.details.medianLuminance ?? '—'}</span>
                </div>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Clipping Ratio</span>
                  <span className={`font-code-sm ${analysis.brightness.details.blownRegionRatio > 0.1 ? 'text-error' : 'text-primary'}`}>
                    {analysis.brightness.details.blownRegionRatio !== undefined ? `${Math.round(analysis.brightness.details.blownRegionRatio * 100)}%` : '—'}
                  </span>
                </div>
                <div className="flex justify-between text-label-md">
                  <span className="text-outline">Spatial Balance</span>
                  <span className="text-primary font-code-sm">{analysis.brightness.details.weightedLuminance?.toFixed(0) ?? '—'}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Uniqueness Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">content_copy</span>
              <h3 className="font-headline-md text-headline-md">Uniqueness</h3>
            </div>
            {analysis?.duplicate?.passed === false && (
              <span className="text-error font-code-sm">DUPLICATE</span>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-md">
            <div className="p-md bg-surface-container-low rounded-lg border border-outline-variant flex items-center gap-lg">
              <div className="w-16 h-16 rounded border-2 border-outline-variant bg-surface-container-highest flex items-center justify-center">
                <span className="material-symbols-outlined text-2xl text-outline">fingerprint</span>
              </div>
              <div className="space-y-1">
                <p className="text-label-md text-outline uppercase tracking-widest font-bold">dHash (Perceptual)</p>
                <p className="font-code-sm text-primary text-[10px] truncate w-[160px]">{analysis?.duplicate?.details?.dHash || 'Analysis Pending...'}</p>
              </div>
            </div>
            <p className="text-body-md text-on-surface-variant">
              {analysis?.duplicate?.passed === false 
                ? `Highly similar image detected. Match distance: ${analysis.duplicate.details.hammingDistance}.`
                : analysis?.duplicate?.passed === true 
                  ? 'Unique visual signature. No perceptually similar images found in recent history.'
                  : 'Searching database for similar visual patterns...'}
            </p>
          </div>
        </div>

        {/* Origin Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">screenshot</span>
              <h3 className="font-headline-md text-headline-md">Origin</h3>
            </div>
            {analysis?.screenshot?.passed === false && (
              <div className="flex items-center gap-xs text-error font-label-md">
                <span className="material-symbols-outlined text-[16px]">warning</span>
                <span>Flagged</span>
              </div>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-sm">
            <div className="flex flex-wrap gap-xs">
              {analysis?.screenshot?.details?.scoreBreakdown && Object.entries(analysis.screenshot.details.scoreBreakdown).map(([key, val]: any) => (
                val > 0 && (
                  <div key={key} className="px-sm py-xs bg-error-container text-on-error-container rounded-sm font-label-sm text-[10px] uppercase">
                    {key.replace(/([A-Z])/g, ' $1')}
                  </div>
                )
              ))}
              {analysis?.screenshot?.passed && (
                <div className="px-sm py-xs bg-secondary/10 text-secondary border border-secondary/20 rounded-sm font-label-sm text-[10px] uppercase">Native Camera</div>
              )}
              {!analysis?.screenshot && (
                <div className="px-sm py-xs bg-surface-container-highest text-outline rounded-sm font-label-sm text-[10px] uppercase animate-pulse">Running Heuristics...</div>
              )}
            </div>
            <p className="text-body-md text-on-surface-variant mt-auto">
              {analysis?.screenshot?.passed === false 
                ? `Device-capture heuristics flagged (Score: ${analysis.screenshot.details.totalScore}/8). Likely non-native content.`
                : analysis?.screenshot?.passed === true
                  ? 'No UI markers, exact screen resolutions, or color palette entropy issues detected.'
                  : 'Analyzing metadata and edge density patterns...'}
            </p>
          </div>
        </div>

        {/* OCR Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">spellcheck</span>
              <h3 className="font-headline-md text-headline-md">Identity Extraction</h3>
            </div>
            <div className="flex flex-col items-end">
              <span className="font-code-sm text-[10px] text-outline uppercase">OCR Confidence</span>
              <span className="font-headline-sm text-primary">
                {analysis?.ocr?.details?.ocrWordConfidence !== undefined ? `${Math.round(analysis.ocr.details.ocrWordConfidence * 100)}%` : '—'}
              </span>
            </div>
          </div>
          <div className="flex-1 space-y-sm">
            <div className={`p-sm bg-surface-container-low border border-outline-variant rounded-lg font-code-sm text-on-surface min-h-[80px] max-h-[120px] overflow-y-auto italic ${!analysis?.ocr ? 'animate-pulse' : 'text-on-surface-variant'}`}>
              {analysis?.ocr?.details?.correctedText ? `"${analysis.ocr.details.correctedText}"` : analysis?.ocr ? '"No clear characters extracted"' : 'Running Tesseract OCR passes...'}
            </div>
            <div className="flex flex-wrap gap-xs">
              {analysis?.ocr?.details?.detectedPlates?.map((plate: string, i: number) => (
                <span key={i} className="px-sm py-1 bg-secondary text-on-secondary rounded font-bold text-label-md tracking-widest border border-secondary">
                  {plate}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Specifications Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">aspect_ratio</span>
              <h3 className="font-headline-md text-headline-md">Specifications</h3>
            </div>
            <span className="text-on-surface-variant font-code-sm">
              {analysis?.dimensions?.details?.aspectRatio ? `${analysis.dimensions.details.aspectRatio.toFixed(2)} AR` : '—'}
            </span>
          </div>
          <div className="flex-1 flex flex-col gap-md">
            <div className="flex-1 flex items-center justify-center bg-surface-container-low rounded-lg border border-outline-variant">
              {analysis?.dimensions?.details ? (
                <div className="text-center">
                  <p className="font-headline-md text-primary">
                    {analysis.dimensions.details.width} × {analysis.dimensions.details.height}
                  </p>
                  <p className="text-label-md text-outline uppercase tracking-widest mt-1">
                    {analysis.dimensions.details.megapixels?.toFixed(1)} Megapixels
                  </p>
                </div>
              ) : (
                <div className="text-outline animate-pulse font-label-md">Validating Metadata...</div>
              )}
            </div>
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-sm">
                <span className="material-symbols-outlined text-outline">data_usage</span>
                <span className="text-body-md text-on-surface-variant">{analysis?.dimensions?.details?.fileSizeMB?.toFixed(2) ?? '—'} MB</span>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${analysis?.dimensions?.passed ? 'bg-secondary/10 text-secondary' : 'bg-error-container text-on-error-container'}`}>
                {analysis?.dimensions ? (analysis.dimensions.passed ? 'Compliant' : 'Out of Bounds') : 'Pending'}
              </span>
            </div>
          </div>
        </div>

      </div>

      {/* Action Footer */}
      <footer className="mt-2xl pt-xl border-t border-outline-variant flex justify-between items-center">
        <div className="flex items-center gap-md text-outline font-body-md">
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined text-[18px]">verified_user</span>
            <span>Security Signature: {job.id.substring(0, 16)}</span>
          </div>
        </div>
        <div className="flex gap-md">
          <Link to="/jobs" className="px-lg py-md border border-primary rounded-lg text-primary font-label-md hover:bg-surface-container-high transition-colors">
            Back to Jobs
          </Link>
          <button className="px-lg py-md bg-primary text-on-primary rounded-lg font-label-md flex items-center gap-sm hover:opacity-90 transition-opacity">
            <span className="material-symbols-outlined text-[20px]">file_download</span>
            Download Full Report
          </button>
        </div>
      </footer>
    </div>
  );
};

export default JobResults;
